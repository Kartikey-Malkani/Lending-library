import { prisma } from '../db.js';
import { toCsvDocument } from '../http/csv.js';
import { todayUtc } from './views.js';

/**
 * CSV of every item currently out on loan.
 *
 * "Currently out" means `status = 'issued'`, and that reading comes from the
 * brief itself rather than from preference: it asks for each item "with its
 * borrower and **due date**", and a requested loan has no due date — the
 * database forbids one (`loans_requested_state_chk`). Including requested loans
 * would emit rows with an empty due-date column, contradicting the description
 * of the file. A requested item is also still on the shelf; it is not out.
 *
 * Overdue loans are included, because an overdue loan is an issued loan.
 * Returned and lost loans are excluded — the item is no longer out.
 *
 * An archived item appears if it has an issued loan. Archiving withdraws an
 * item from circulation but does not end a loan already in someone's hands, and
 * those are exactly the ones a librarian needs to chase.
 */

export const EXPORT_COLUMNS = [
  'item_code',
  'item_title',
  'borrower_name',
  'borrower_email',
  'issued_on',
  'due_on',
  'days_overdue',
] as const;

/** YYYY-MM-DD, UTC, matching how due dates are stored and compared. */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function daysOverdue(dueOn: Date, asOf: Date): number {
  const diff = todayUtc(asOf).getTime() - dueOn.getTime();
  return diff <= 0 ? 0 : Math.floor(diff / 86_400_000);
}

export async function buildOnLoanCsv(asOf: Date = new Date()): Promise<string> {
  const loans = await prisma.loan.findMany({
    // Filtered in the database. Nothing loads the whole loan table and narrows
    // it here.
    where: { status: 'issued' },
    orderBy: [{ dueOn: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    select: {
      issuedAt: true,
      dueOn: true,
      item: { select: { code: true, title: true } },
      borrower: { select: { name: true, email: true } },
    },
  });

  const rows = loans.map((loan) => [
    loan.item.code,
    loan.item.title,
    loan.borrower.name,
    loan.borrower.email,
    loan.issuedAt ? isoDate(loan.issuedAt) : '',
    loan.dueOn ? isoDate(loan.dueOn) : '',
    loan.dueOn ? daysOverdue(loan.dueOn, asOf) : 0,
  ]);

  return toCsvDocument(EXPORT_COLUMNS, rows);
}

/** `items-on-loan-2026-09-04.csv` */
export function onLoanCsvFilename(asOf: Date = new Date()): string {
  return `items-on-loan-${isoDate(todayUtc(asOf))}.csv`;
}
