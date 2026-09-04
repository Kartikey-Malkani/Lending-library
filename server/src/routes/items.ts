import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireCapability } from '../auth/middleware.js';
import { replaceCustodians } from '../catalogue/custodians.js';
import { importCatalogueItems } from '../catalogue/import.js';
import { catalogueItemInputSchema } from '../catalogue/validation.js';
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
import { ApiError, asyncHandler } from '../http/errors.js';
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

// Shared with the CSV importer so both hold a new item to the same rules.
const createItemSchema = catalogueItemInputSchema;

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

/**
 * Bulk import of catalogue items from a CSV body.
 *
 * Partial success by design: valid rows are imported even when others fail, and
 * the response names every failure with the row number a spreadsheet shows. The
 * status is 200 rather than 201 because the outcome is a report — a request in
 * which every row failed is still a successfully processed report, not a
 * failed request.
 */
itemsRouter.post(
  '/items/import',
  requireCapability('bulk:import'),
  asyncHandler(async (req, res) => {
    const csv = req.body;
    if (typeof csv !== 'string' || csv.trim() === '') {
      throw ApiError.badRequest(
        'Send the CSV file as the request body with Content-Type: text/csv.',
      );
    }

    const user = currentUser(req);
    // The creating librarian comes from the session. Nothing in the file can
    // name an actor.
    res.json(await importCatalogueItems(csv, user.userId));
  }),
);
