import { Router } from 'express';
import { z } from 'zod';
import { assertCanAccessOwnedResource, currentUser, requireCapability } from '../auth/middleware.js';
import {
  createIssuedLoan,
  getLoanWithTimeline,
  issueLoan,
  markLoanLost,
  requestLoan,
  returnLoan,
} from '../loans/service.js';
import { asyncHandler } from '../http/errors.js';
import { parseBody, parseUuidParam } from '../http/validation.js';

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

const requestSchema = z.object({ itemId: z.string().uuid() }).strict();

const createIssuedSchema = z
  .object({
    itemId: z.string().uuid(),
    borrowerId: z.string().uuid(),
    dueOn: dueOnSchema,
    note: noteSchema,
  })
  .strict();

const issueSchema = z.object({ dueOn: dueOnSchema, note: noteSchema }).strict();
const noteOnlySchema = z.object({ note: noteSchema }).strict();

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
