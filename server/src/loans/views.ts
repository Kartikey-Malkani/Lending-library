import type { Loan, LoanEvent, LoanStatus } from '@prisma/client';

/**
 * How loans are represented over the wire.
 *
 * `isOverdue` is computed here, on every read, and is never stored. The
 * `loan_status` enum has no `overdue` member, so there is nothing to store even
 * if a future code path wanted to — see docs/decisions.md, Decision 2.
 */

export type LoanView = {
  id: string;
  itemId: string;
  borrowerId: string;
  status: LoanStatus;
  isOverdue: boolean;
  requestedAt: Date;
  issuedAt: Date | null;
  dueOn: Date | null;
  returnedAt: Date | null;
  lostAt: Date | null;
};

export type LoanEventView = {
  id: string;
  type: string;
  note: string | null;
  createdAt: Date;
  actor: { id: string; name: string };
};

/** UTC midnight today. `due_on` is a DATE, so the comparison is calendar-based. */
export function todayUtc(asOf: Date = new Date()): Date {
  return new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
}

/**
 * A loan is overdue when it is still Issued and its due date has passed.
 *
 * Due *today* is not overdue — the borrower has the rest of the day. Only a
 * strictly earlier date counts. A returned or lost loan is never overdue,
 * however far past its due date it went: it is closed.
 *
 * Milestone 6 needs the same rule in SQL for filtering and sorting. The two
 * must agree, which is why the rule is stated once here rather than inlined at
 * each call site.
 */
export function isOverdue(
  loan: Pick<Loan, 'status' | 'dueOn'>,
  asOf: Date = new Date(),
): boolean {
  if (loan.status !== 'issued' || loan.dueOn === null) return false;
  return loan.dueOn.getTime() < todayUtc(asOf).getTime();
}

export function toLoanView(loan: Loan, asOf: Date = new Date()): LoanView {
  return {
    id: loan.id,
    itemId: loan.itemId,
    borrowerId: loan.borrowerId,
    status: loan.status,
    isOverdue: isOverdue(loan, asOf),
    requestedAt: loan.requestedAt,
    issuedAt: loan.issuedAt,
    dueOn: loan.dueOn,
    returnedAt: loan.returnedAt,
    lostAt: loan.lostAt,
  };
}

export function toEventView(
  event: LoanEvent & { actor: { id: string; name: string } },
): LoanEventView {
  return {
    id: event.id,
    type: event.type,
    note: event.note,
    createdAt: event.createdAt,
    actor: { id: event.actor.id, name: event.actor.name },
  };
}
