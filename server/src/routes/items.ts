import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireCapability } from '../auth/middleware.js';
import { replaceCustodians } from '../catalogue/custodians.js';
import {
  archiveItem,
  createItem,
  getItemOrThrow,
  listCustodians,
  listItems,
  listItemsForCustodian,
  restoreItem,
  toItemView,
  updateItem,
} from '../catalogue/service.js';
import { listLoansForItem } from '../loans/service.js';
import { asyncHandler } from '../http/errors.js';
import {
  boundedText,
  paginationSchema,
  parseBody,
  parseQuery,
  parseUuidParam,
  sortDirectionSchema,
} from '../http/validation.js';

export const itemsRouter = Router();

const archivedFilterSchema = z.enum(['false', 'true', 'all']).default('false');

/**
 * Sort keys are a whitelist, never interpolated. An unknown key is a 400, which
 * is also what stops a caller ordering by a column they should not see.
 */
const listQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
  category: z.string().trim().max(200).optional(),
  archived: archivedFilterSchema,
  sort: z.enum(['title', 'code', 'category', 'createdAt']).default('title'),
  dir: sortDirectionSchema,
});

const createItemSchema = z
  .object({
    title: boundedText(200),
    category: boundedText(100),
    code: boundedText(50),
  })
  .strict();

// At least one field, so an empty PATCH is a bad request rather than a silent
// no-op that reports success.
const updateItemSchema = z
  .object({
    title: boundedText(200).optional(),
    category: boundedText(100).optional(),
    code: boundedText(50).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

const custodiansSchema = z
  .object({
    librarianIds: z.array(z.string().uuid()).max(50),
  })
  .strict();

// --- Reads -----------------------------------------------------------------

itemsRouter.get(
  '/items',
  requireCapability('catalogue:read'),
  asyncHandler(async (req, res) => {
    const query = parseQuery(req, listQuerySchema);
    res.json(await listItems(query));
  }),
);

/**
 * Registered before `/items/:id`, or Express would match "mine" as an id.
 *
 * The librarian is taken from the session. There is deliberately no parameter
 * for whose items to list — that would be an authorization hole with a
 * convenient name.
 */
itemsRouter.get(
  '/items/mine',
  requireCapability('custodian:read-own'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = parseQuery(
      req,
      paginationSchema.extend({ archived: archivedFilterSchema }),
    );
    res.json(await listItemsForCustodian(user.userId, query));
  }),
);

itemsRouter.get(
  '/items/:id',
  requireCapability('catalogue:read'),
  asyncHandler(async (req, res) => {
    const id = parseUuidParam(req, 'id');
    const item = await getItemOrThrow(id);
    const user = currentUser(req);

    // Custodian assignments and the loan history are librarian-only, so for a
    // member neither is fetched at all rather than fetched and stripped. The
    // loan history would otherwise reveal who else has borrowed the item.
    if (user.role !== 'librarian') {
      res.json({ item: toItemView(item) });
      return;
    }

    const [custodians, loans] = await Promise.all([listCustodians(id), listLoansForItem(id)]);
    res.json({ item: toItemView(item), custodians, loans });
  }),
);

// --- Writes ----------------------------------------------------------------

itemsRouter.post(
  '/items',
  requireCapability('catalogue:write'),
  asyncHandler(async (req, res) => {
    const body = parseBody(req, createItemSchema);
    const user = currentUser(req);
    res.status(201).json({ item: await createItem(body, user.userId) });
  }),
);

itemsRouter.patch(
  '/items/:id',
  requireCapability('catalogue:write'),
  asyncHandler(async (req, res) => {
    const id = parseUuidParam(req, 'id');
    const body = parseBody(req, updateItemSchema);
    res.json({ item: await updateItem(id, body) });
  }),
);

itemsRouter.post(
  '/items/:id/archive',
  requireCapability('catalogue:archive'),
  asyncHandler(async (req, res) => {
    const id = parseUuidParam(req, 'id');
    res.json({ item: await archiveItem(id) });
  }),
);

itemsRouter.post(
  '/items/:id/restore',
  requireCapability('catalogue:archive'),
  asyncHandler(async (req, res) => {
    const id = parseUuidParam(req, 'id');
    res.json({ item: await restoreItem(id) });
  }),
);

itemsRouter.put(
  '/items/:id/custodians',
  requireCapability('custodian:manage'),
  asyncHandler(async (req, res) => {
    const id = parseUuidParam(req, 'id');
    const { librarianIds } = parseBody(req, custodiansSchema);
    const user = currentUser(req);
    res.json({ custodians: await replaceCustodians(id, librarianIds, user.userId) });
  }),
);
