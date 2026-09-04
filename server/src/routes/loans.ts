import { Router } from 'express';
import { z } from 'zod';
import {
  assertCanAccessOwnedResource,
  currentUser,
  requireCapability,
  resolveBorrowerScope,
} from '../auth/middleware.js';
import {
  createIssuedLoan,
  getLoanWithTimeline,
  issueLoan,
  listLoans,
  markLoanLost,
  requestLoan,
  returnLoan,
} from '../loans/service.js';
import { bulkReturnLoans, MAX_BULK_RETURN } from '../loans/bulk.js';
import { buildOnLoanCsv, onLoanCsvFilename } from '../loans/export.js';
import { ApiError, asyncHandler } from '../http/errors.js';
import {
  paginationSchema,
  parseBody,
  parseQuery,
  parseUuidParam,
  sortDirectionSchema,
} from '../http/validation.js';

export const loansRouter = Router();

/**
 * An optional librarian note.
 *
 * The brief says the timeline carries "any notes left by a librarian", so a
 * note is never required. What is enforced is that a note which *is* supplied
 * says something: whitespace is trimmed, and a blank string is a bad request
 * rather than a row of spaces stored in the permanent record.
 */
const noteSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1, 'must not be blank').max(1000, 'must be at most 1000 characters'))
  .optional();

/**
 * A due date, as a calendar date.
 *
 * Deliberately not restricted to the future. A past due date is how a loan
 * legitimately becomes overdue — backdating an issue is a real thing a
 * librarian does — and the brief imposes no such restriction.
 */
const dueOnSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD form')
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((date) => !Number.isNaN(date.getTime()), { message: 'must be a real date' });

/**
 * The loans list query.
 *
 * `sort` and `dir` are whitelists, so an unknown key is a 400 rather than
 * something interpolated into a query or silently ignored. `status` accepts the
 * four real statuses plus `overdue`, which is derived rather than stored.
 */
const listQuerySchema = paginationSchema.extend({
  search: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['requested', 'issued', 'returned', 'lost', 'overdue']).optional(),
  itemId: z.string().uuid().optional(),
  borrowerId: z.string().uuid().optional(),
  sort: z.enum(['dueOn', 'requestedAt', 'status']).default('requestedAt'),
  dir: sortDirectionSchema,
});

const requestSchema = z.object({ itemId: z.string().uuid() }).strict();

const createIssuedSchema = z
  .object({
    itemId: z.string().uuid(),
    borrowerId: z.string().uuid(),
    dueOn: dueOnSchema,
    note: noteSchema,
  })
  .strict();

const bulkReturnSchema = z
  .object({
    loanIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_RETURN),
    note: noteSchema,
  })
  .strict();

const issueSchema = z.object({ dueOn: dueOnSchema, note: noteSchema }).strict();
const noteOnlySchema = z.object({ note: noteSchema }).strict();

/**
 * One list of loans across the whole catalogue.
 *
 * Registered before `/loans/:id` for readability; the two paths do not actually
 * collide.
 *
 * Members are scoped to their own loans by the server, not by asking nicely: a
 * `borrowerId` in the query string is discarded for them, so changing it can
 * never widen what they see. Librarians may use it as a real filter.
 */
loansRouter.get(
  '/loans',
  requireCapability('loan:read'),
  asyncHandler(async (req, res) => {
    const query = parseQuery(req, listQuerySchema);
    const borrowerId = resolveBorrowerScope(req, query.borrowerId);

    res.json(await listLoans({ ...query, borrowerId }));
  }),
);

/**
 * A member requesting an item for themselves.
 *
 * There is no `borrowerId` parameter, so there is nothing for a member to
 * tamper with: the borrower is the session user, full stop. A librarian
 * borrowing something uses this same route — they are a person too. Acting on
 * someone else's behalf is what POST /loans is for.
 */
loansRouter.post(
  '/loans/request',
  requireCapability('loan:request'),
  asyncHandler(async (req, res) => {
    const { itemId } = parseBody(req, requestSchema);
    const user = currentUser(req);

    const loan = await requestLoan({ itemId, borrowerId: user.userId });
    res.status(201).json({ loan });
  }),
);

/** A librarian issuing an item directly, without a prior request. */
loansRouter.post(
  '/loans',
  requireCapability('loan:create-issued'),
  asyncHandler(async (req, res) => {
    const body = parseBody(req, createIssuedSchema);
    const user = currentUser(req);

    const loan = await createIssuedLoan({ ...body, actorId: user.userId });
    res.status(201).json({ loan });
  }),
);

loansRouter.post(
  '/loans/:id/issue',
  requireCapability('loan:issue'),
  asyncHandler(async (req, res) => {
    const id = parseUuidParam(req, 'id');
    const body = parseBody(req, issueSchema);
    const user = currentUser(req);

    res.json({ loan: await issueLoan({ loanId: id, ...body, actorId: user.userId }) });
  }),
);

loansRouter.post(
  '/loans/:id/return',
  requireCapability('loan:return'),
  asyncHandler(async (req, res) => {
    const id = parseUuidParam(req, 'id');
    const { note } = parseBody(req, noteOnlySchema);
    const user = currentUser(req);

    res.json({ loan: await returnLoan({ loanId: id, note, actorId: user.userId }) });
  }),
);

loansRouter.post(
  '/loans/:id/lost',
  requireCapability('loan:lost'),
  asyncHandler(async (req, res) => {
    const id = parseUuidParam(req, 'id');
    const { note } = parseBody(req, noteOnlySchema);
    const user = currentUser(req);

    res.json({ loan: await markLoanLost({ loanId: id, note, actorId: user.userId }) });
  }),
);

/**
 * CSV of every item currently out on loan.
 *
 * Registered before `/loans/:id`, and that ordering is load-bearing: Express
 * matches in order, so `:id` would otherwise capture "export.csv" and the
 * request would 404 on a malformed uuid instead of returning the file.
 */
loansRouter.get(
  '/loans/export.csv',
  requireCapability('export:on-loan'),
  asyncHandler(async (_req, res) => {
    const csv = await buildOnLoanCsv();

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${onLoanCsvFilename()}"`);
    res.send(csv);
  }),
);

/**
 * Returning several issued loans in one action.
 *
 * Repeated loan ids are rejected rather than deduplicated. The response is a
 * per-loan result, so every entry should correspond to exactly one requested
 * loan; reporting the second occurrence of an id as "already returned" would
 * describe the caller's own repetition as though it were a fact about the data.
 */
loansRouter.post(
  '/loans/bulk-return',
  requireCapability('bulk:return'),
  asyncHandler(async (req, res) => {
    const { loanIds, note } = parseBody(req, bulkReturnSchema);

    const duplicates = [...new Set(loanIds.filter((id, i) => loanIds.indexOf(id) !== i))];
    if (duplicates.length > 0) {
      throw new ApiError(
        400,
        'duplicate_loan_id',
        'Each loan may appear only once in a bulk return.',
        duplicates.map((id) => ({ field: 'loanIds', message: `Repeated loan id: ${id}` })),
      );
    }

    const user = currentUser(req);
    res.json(await bulkReturnLoans({ loanIds, note, actorId: user.userId }));
  }),
);

/**
 * A loan and its timeline.
 *
 * Role decides whether you may read loans at all; ownership decides which ones.
 * The borrower id compared here comes from the row the server loaded, so
 * changing the id in the URL can only produce a 403 or a 404 — never someone
 * else's loan.
 */
loansRouter.get(
  '/loans/:id',
  requireCapability('loan:read'),
  asyncHandler(async (req, res) => {
    const id = parseUuidParam(req, 'id');
    const { loan, events } = await getLoanWithTimeline(id);

    assertCanAccessOwnedResource(req, loan.borrowerId);

    res.json({ loan, events });
  }),
);
