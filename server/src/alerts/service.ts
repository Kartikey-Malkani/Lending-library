import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { ApiError } from '../http/errors.js';
import type { Paginated } from '../http/validation.js';
import { todayUtc } from '../loans/views.js';

/**
 * Overdue alerts: goal 10.
 *
 * An alert is not a stored thing. It is a loan that is still issued past its due
 * date and that this librarian has not dismissed — computed on every read, from
 * the same `todayUtc` boundary the loans list and the dashboard use.
 *
 * Dismissal is keyed on `(loan_id, user_id)`, and both halves matter:
 *
 *   loan_id  is what makes the brief's rule work without any special case. "If
 *            the item is later issued again and becomes overdue on the new
 *            loan, the alert returns" — a later issue is a NEW loan row, so no
 *            dismissal exists for it. Keying on the item instead would suppress
 *            the alert forever, while looking identical in a demo.
 *
 *   user_id  keeps one librarian from silently hiding an overdue item from the
 *            rest of the team, and makes the nav badge belong to its viewer.
 */

export type AlertRow = {
  loanId: string;
  dueOn: Date;
  daysOverdue: number;
  item: { id: string; code: string; title: string; isArchived: boolean };
  borrower: { id: string; name: string; email: string };
};

export type AlertsView = Paginated<AlertRow> & {
  /** Undismissed overdue loans in total — what the navigation badge shows. */
  count: number;
};

/** The one predicate behind both the badge count and the listed rows. */
function overdueForUser(userId: string, today: Date): Prisma.LoanWhereInput {
  return {
    status: 'issued',
    dueOn: { lt: today },
    // Prisma renders this as NOT EXISTS, so a dismissal by another librarian
    // does not remove the alert from this one.
    dismissals: { none: { userId } },
  };
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

export async function listAlerts(input: {
  userId: string;
  page: number;
  pageSize: number;
  asOf?: Date | undefined;
}): Promise<AlertsView> {
  const asOf = input.asOf ?? new Date();
  const today = todayUtc(asOf);
  const where = overdueForUser(input.userId, today);

  const [rows, count] = await Promise.all([
    prisma.loan.findMany({
      where,
      // Most overdue first; `id` keeps paging stable when due dates collide.
      orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: {
        id: true,
        dueOn: true,
        item: { select: { id: true, code: true, title: true, archivedAt: true } },
        borrower: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.loan.count({ where }),
  ]);

  return {
    count,
    total: count,
    page: input.page,
    pageSize: input.pageSize,
    rows: rows.map((loan) => ({
      loanId: loan.id,
      dueOn: loan.dueOn!,
      daysOverdue: daysBetween(loan.dueOn!, today),
      item: {
        id: loan.item.id,
        code: loan.item.code,
        title: loan.item.title,
        isArchived: loan.item.archivedAt !== null,
      },
      borrower: loan.borrower,
    })),
  };
}

/**
 * Dismisses the alert for one loan, for one librarian.
 *
 * The guard and the write are a single statement. `INSERT ... SELECT ... WHERE`
 * only inserts if the loan is overdue *at the moment of the insert*, so there is
 * no window in which a check could go stale between reading and writing.
 *
 * Why the guard exists at all: a dismissal must represent dismissing an alert
 * that is actually showing. If a librarian could dismiss a loan that is issued
 * but not yet due, the row would sit there and suppress the alert when the loan
 * later became overdue — silently pre-muting a future warning. Requiring it to
 * be overdue *now* closes that.
 *
 * The reverse staleness is harmless and deliberately not guarded against: if the
 * loan is returned a moment after the insert, the dismissal simply refers to a
 * loan that can never alert again. `returned` and `lost` are terminal, and a
 * later loan on the same item is a different row, so a stale dismissal cannot
 * suppress anything.
 *
 * `ON CONFLICT DO NOTHING` makes a repeat dismissal idempotent — the same set
 * membership reasoning as custodian assignment.
 */
export async function dismissAlert(input: {
  loanId: string;
  userId: string;
  asOf?: Date | undefined;
}): Promise<void> {
  const today = todayUtc(input.asOf ?? new Date());

  const inserted = await prisma.$executeRaw`
    INSERT INTO alert_dismissals (loan_id, user_id)
    SELECT ${input.loanId}::uuid, ${input.userId}::uuid
      FROM loans
     WHERE id = ${input.loanId}::uuid
       AND status = 'issued'
       AND due_on < ${today}
    ON CONFLICT (loan_id, user_id) DO NOTHING
  `;

  if (inserted === 1) return;

  // Nothing was inserted. Three reasons, and they need different answers, so
  // work out which one it was — these reads are diagnostic only, after the
  // atomic write has already decided the outcome.
  const existing = await prisma.alertDismissal.findUnique({
    where: { loanId_userId: { loanId: input.loanId, userId: input.userId } },
    select: { loanId: true },
  });
  if (existing) return; // Already dismissed: idempotent.

  const loan = await prisma.loan.findUnique({
    where: { id: input.loanId },
    select: { status: true },
  });
  if (!loan) throw ApiError.notFound('Loan not found.');

  throw ApiError.conflict(
    'not_overdue',
    'This loan is not currently overdue, so there is no alert to dismiss.',
  );
}
