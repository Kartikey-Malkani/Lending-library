import type { Loan, LoanStatus, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { ApiError, isUniqueViolationOn } from '../http/errors.js';
import { type LoanEventView, type LoanView, toEventView, toLoanView } from './views.js';

/**
 * The loan lifecycle.
 *
 *   (none) --request--> Requested --issue--> Issued --return--> Returned
 *                          (none) --direct issue--> Issued --lost--> Lost
 *
 * Overdue is not in that diagram because it is not a state: a loan is treated
 * as overdue whenever it is still Issued past its due date, computed at read
 * time. See views.ts.
 *
 * Three invariants are enforced here, each by a different mechanism, chosen
 * because each race is different:
 *
 *  1. At most one open loan per item — the partial unique index
 *     `loans_one_open_per_item_idx`. Authoritative. This module never
 *     pre-checks for an open loan and treats the answer as durable; it attempts
 *     the write and translates the violation.
 *
 *  2. No new or newly-issued loan against an archived item — a row lock on the
 *     catalogue item (`SELECT ... FOR UPDATE`), taken before the loan is
 *     written. Archiving takes the same row's lock via its UPDATE, so the two
 *     serialize: either the loan commits before the archive, or the archive
 *     commits and the loan attempt sees it and is refused.
 *
 *  3. One transition per loan — a conditional UPDATE that names the state the
 *     caller believed the loan was in. The second of two concurrent returns
 *     matches zero rows and is refused, so exactly one event is written.
 *
 * Lock ordering is always item first, then loan. Consistency here is what stops
 * two operations deadlocking against each other.
 */

export type LoanWithTimeline = {
  loan: LoanView;
  events: LoanEventView[];
};

/** Every operation stamps all of its timestamps from one clock reading. */
type Clock = { now: Date };

function clock(): Clock {
  return { now: new Date() };
}

// --- Guards ----------------------------------------------------------------

/**
 * Locks the catalogue item and refuses if it is archived.
 *
 * The lock is the point. A plain `SELECT archived_at` then `INSERT` leaves a
 * window: archive can commit between the two, and the loan lands against an
 * item that is already out of circulation. `FOR UPDATE` blocks until any
 * in-flight archive commits and then re-reads the committed row, so the check
 * cannot be stale by the time the loan is written.
 *
 * Archiving an item that already has an open loan stays legal — that is a write
 * to `catalogue_items`, and it does not touch the loan. Archiving stops an item
 * going out; it never stops one coming back.
 */
async function lockItemForNewOrIssuedLoan(
  tx: Prisma.TransactionClient,
  itemId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string; archived_at: Date | null }[]>`
    SELECT id, archived_at FROM catalogue_items WHERE id = ${itemId}::uuid FOR UPDATE
  `;

  const item = rows[0];
  if (!item) throw ApiError.notFound('Catalogue item not found.');

  if (item.archived_at !== null) {
    throw ApiError.conflict(
      'item_archived',
      'This item is archived and cannot be loaned out. Restore it first.',
    );
  }
}

async function assertBorrowerExists(
  tx: Prisma.TransactionClient,
  borrowerId: string,
): Promise<void> {
  const borrower = await tx.user.findUnique({ where: { id: borrowerId }, select: { id: true } });
  if (!borrower) {
    throw ApiError.badRequest('The borrower does not exist.', [
      { field: 'borrowerId', message: `No such user: ${borrowerId}` },
    ]);
  }
}

/** The partial unique index fired: some other loan already holds this item. */
function translateOpenLoanConflict(error: unknown): unknown {
  if (isUniqueViolationOn(error, 'item_id')) {
    return ApiError.conflict(
      'item_unavailable',
      'This item already has an open loan against it.',
    );
  }
  return error;
}

// --- Creating loans --------------------------------------------------------

export async function requestLoan(input: {
  itemId: string;
  borrowerId: string;
}): Promise<LoanView> {
  const { now } = clock();

  try {
    return await prisma.$transaction(async (tx) => {
      await lockItemForNewOrIssuedLoan(tx, input.itemId);

      const loan = await tx.loan.create({
        data: {
          itemId: input.itemId,
          borrowerId: input.borrowerId,
          status: 'requested',
          requestedAt: now,
        },
      });

      await tx.loanEvent.create({
        data: { loanId: loan.id, type: 'requested', actorId: input.borrowerId, createdAt: now },
      });

      return toLoanView(loan, now);
    });
  } catch (error) {
    throw translateOpenLoanConflict(error);
  }
}

/**
 * A librarian handing an item over at the counter, with no prior request.
 *
 * Writes two events — `requested` then `issued`, both at the same instant — so
 * that a loan's timeline has the same shape however it reached Issued. A
 * reviewer comparing two issued loans should not have to know which one came
 * from a member's request to read its history.
 */
export async function createIssuedLoan(input: {
  itemId: string;
  borrowerId: string;
  dueOn: Date;
  note?: string | undefined;
  actorId: string;
}): Promise<LoanView> {
  const { now } = clock();

  try {
    return await prisma.$transaction(async (tx) => {
      await lockItemForNewOrIssuedLoan(tx, input.itemId);
      await assertBorrowerExists(tx, input.borrowerId);

      const loan = await tx.loan.create({
        data: {
          itemId: input.itemId,
          borrowerId: input.borrowerId,
          status: 'issued',
          requestedAt: now,
          issuedAt: now,
          dueOn: input.dueOn,
          issuedById: input.actorId,
        },
      });

      await tx.loanEvent.createMany({
        data: [
          { loanId: loan.id, type: 'requested', actorId: input.actorId, createdAt: now },
          {
            loanId: loan.id,
            type: 'issued',
            actorId: input.actorId,
            note: input.note ?? null,
            createdAt: now,
          },
        ],
      });

      return toLoanView(loan, now);
    });
  } catch (error) {
    throw translateOpenLoanConflict(error);
  }
}

// --- Transitions -----------------------------------------------------------

/**
 * Explains why a transition was refused, in terms of where the loan actually is.
 *
 * The brief requires an illegal move to be "rejected by the server with a
 * message explaining why", so this names the current state rather than saying
 * only that something went wrong.
 */
function refuseTransition(current: LoanStatus, attempted: string): ApiError {
  const reasons: Record<LoanStatus, string> = {
    requested: 'it has not been issued yet',
    issued: 'it is currently on loan',
    returned: 'it has already been returned',
    lost: 'it has been marked lost',
  };

  return ApiError.conflict(
    'invalid_transition',
    `Cannot ${attempted} this loan because ${reasons[current]}. The loan is ${current}.`,
    { currentStatus: current, attempted },
  );
}

/**
 * Applies a state change, or explains why it cannot.
 *
 * The conditional UPDATE is the concurrency control: it names the state the
 * caller believed the loan was in, so a second concurrent attempt matches zero
 * rows once the first commits. Because the event is written after that check
 * and inside the same transaction, a refused transition leaves no trace and a
 * successful one can never exist without its timeline entry.
 */
async function transition(input: {
  loanId: string;
  from: LoanStatus;
  attempted: string;
  data: Prisma.LoanUncheckedUpdateManyInput;
  event: { type: 'issued' | 'returned' | 'lost'; actorId: string; note?: string | undefined };
  now: Date;
  lockItem: boolean;
}): Promise<LoanView> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.loan.findUnique({
      where: { id: input.loanId },
      select: { id: true, itemId: true, status: true },
    });
    if (!existing) throw ApiError.notFound('Loan not found.');

    // Item first, then loan — one lock order everywhere, so two operations
    // cannot deadlock by taking the same two locks in opposite orders.
    if (input.lockItem) {
      await lockItemForNewOrIssuedLoan(tx, existing.itemId);
    }

    const { count } = await tx.loan.updateMany({
      where: { id: input.loanId, status: input.from },
      data: input.data,
    });

    if (count === 0) {
      const current = await tx.loan.findUniqueOrThrow({
        where: { id: input.loanId },
        select: { status: true },
      });
      throw refuseTransition(current.status, input.attempted);
    }

    await tx.loanEvent.create({
      data: {
        loanId: input.loanId,
        type: input.event.type,
        actorId: input.event.actorId,
        note: input.event.note ?? null,
        createdAt: input.now,
      },
    });

    const updated = await tx.loan.findUniqueOrThrow({ where: { id: input.loanId } });
    return toLoanView(updated, input.now);
  });
}

export async function issueLoan(input: {
  loanId: string;
  dueOn: Date;
  note?: string | undefined;
  actorId: string;
}): Promise<LoanView> {
  const { now } = clock();

  return transition({
    loanId: input.loanId,
    from: 'requested',
    attempted: 'issue',
    // The item is locked here too: a request made before the item was archived
    // must not become an issued loan afterwards.
    lockItem: true,
    data: { status: 'issued', issuedAt: now, dueOn: input.dueOn, issuedById: input.actorId },
    event: { type: 'issued', actorId: input.actorId, note: input.note },
    now,
  });
}

export async function returnLoan(input: {
  loanId: string;
  note?: string | undefined;
  actorId: string;
}): Promise<LoanView> {
  const { now } = clock();

  return transition({
    loanId: input.loanId,
    from: 'issued',
    attempted: 'return',
    // Deliberately no item lock. Returning an archived item is not only
    // allowed, it is the whole point of archiving not cancelling loans.
    lockItem: false,
    data: { status: 'returned', returnedAt: now, returnedById: input.actorId },
    event: { type: 'returned', actorId: input.actorId, note: input.note },
    now,
  });
}

export async function markLoanLost(input: {
  loanId: string;
  note?: string | undefined;
  actorId: string;
}): Promise<LoanView> {
  const { now } = clock();

  return transition({
    loanId: input.loanId,
    from: 'issued',
    attempted: 'mark lost',
    lockItem: false,
    data: { status: 'lost', lostAt: now },
    // There is no `lost_by` column; the actor for this transition lives in the
    // timeline, which is the authoritative record of who did what.
    event: { type: 'lost', actorId: input.actorId, note: input.note },
    now,
  });
}

// --- Reads -----------------------------------------------------------------

export async function getLoanOrThrow(loanId: string): Promise<Loan> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (!loan) throw ApiError.notFound('Loan not found.');
  return loan;
}

export async function getLoanWithTimeline(loanId: string): Promise<LoanWithTimeline> {
  const loan = await getLoanOrThrow(loanId);

  const events = await prisma.loanEvent.findMany({
    where: { loanId },
    include: { actor: { select: { id: true, name: true } } },
    /*
     * Ordered by (created_at, type, id).
     *
     * WHY A TIEBREAK IS NEEDED: a direct issue writes `requested` and `issued`
     * inside one transaction at the same instant, because the loan genuinely
     * passes through both states. `created_at` alone cannot separate them, and
     * falling back to a random uuid returned them in a random order — the
     * timeline read backwards roughly half the time.
     *
     * WHY `type` IS SUFFICIENT TODAY: the loan_event_type enum is declared in
     * lifecycle order (requested, issued, returned, lost) and Postgres sorts
     * enum columns by declaration order, so comparing `type` compares lifecycle
     * position. That is a correct tiebreak because a single loan can never hold
     * two events of the same type:
     *
     *   requested  written once, at loan creation, and a loan is created once
     *   issued     written by createIssuedLoan at creation, or by the
     *              requested -> issued transition; a loan can take exactly one
     *              of those two paths, and issued -> issued is refused
     *   returned   only from issued, and returned -> returned is refused
     *   lost       only from issued, and lost -> lost is refused
     *
     * So `type` is not merely a tiebreak here, it is a total order over one
     * loan's events. `id` remains as a final key so the ORDER BY is fully
     * determined regardless.
     *
     * THE LIMITATION, STATED PLAINLY: this holds only while every event type is
     * a one-per-loan lifecycle transition. Adding an event type that can occur
     * more than once — a standalone librarian note, a renewal, a condition
     * check — would allow two events of the same type at the same timestamp,
     * and enum order alone could no longer separate them.
     *
     * THE FIX AT THAT POINT: a monotonic ordering column on loan_events (a
     * `bigserial` sequence, or a per-loan sequence number) in a NEW migration,
     * ordered by (loan_id, seq). Deliberately not added now: it would be a
     * migration to solve a problem the current event model does not have.
     * `loans-lifecycle.test.ts` asserts the one-per-loan property directly, so
     * the day it stops being true, a test says so.
     */
    orderBy: [{ createdAt: 'asc' }, { type: 'asc' }, { id: 'asc' }],
  });

  return { loan: toLoanView(loan), events: events.map(toEventView) };
}

/** Every loan ever made against an item, newest first. Librarian-only at the route. */
export async function listLoansForItem(itemId: string): Promise<LoanView[]> {
  const loans = await prisma.loan.findMany({
    where: { itemId },
    orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
  });
  return loans.map((loan) => toLoanView(loan));
}
