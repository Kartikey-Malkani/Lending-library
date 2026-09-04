import type { LoanStatus } from '@prisma/client';
import { prisma } from '../db.js';
import { todayUtc } from '../loans/views.js';

/**
 * The dashboard: goal 8.
 *
 * Every number here is computed by the database. Nothing loads loans or items
 * into the process and counts them in TypeScript — the endpoint is a single
 * request because a landing page should not need five round trips, not because
 * the work has been moved into the application.
 *
 * One `asOf` is threaded through the whole request. Overdue, "this week" and
 * the eight chart buckets are all derived from that single instant, so the
 * headline "returned this week" and the final bar of the chart cannot disagree
 * — which, on one screen, would read as a bug rather than a rounding difference.
 */

export const CHART_WEEKS = 8;

export type DashboardView = {
  /** The instant every number below was computed against. */
  asOf: string;
  headline: {
    itemsCurrentlyOut: number;
    itemsOverdue: number;
    loansReturnedThisWeek: number;
    /** Active items. Archived ones are reported separately rather than folded in. */
    totalItems: number;
    archivedItems: number;
  };
  /** The four real lifecycle statuses. Overdue is not one of them. */
  byStatus: { status: LoanStatus; count: number }[];
  /**
   * Loans per custodian, including an `Unassigned` bucket.
   *
   * These counts deliberately do NOT sum to the total number of loans. An item
   * may have several custodians, and a loan on it counts once for each of them,
   * because each is responsible for that item. Forcing the figures to sum would
   * mean either dropping custodians or inventing a split, both of which answer a
   * different question than the one asked.
   */
  byCustodian: { custodianId: string | null; name: string; count: number }[];
  /** Exactly CHART_WEEKS buckets, oldest first, current ISO week last. */
  returnsPerWeek: { weekStart: string; count: number }[];
};

const ALL_STATUSES: LoanStatus[] = ['requested', 'issued', 'returned', 'lost'];

/**
 * Midnight UTC on the Monday of the ISO week containing `asOf`.
 *
 * Computed here rather than with Postgres `date_trunc` so that every boundary in
 * the response — the "this week" headline and all eight chart buckets — comes
 * from the same `asOf` value, in one place, in one timezone.
 */
export function isoWeekStartUtc(asOf: Date): Date {
  const midnight = todayUtc(asOf);
  const daysSinceMonday = (midnight.getUTCDay() + 6) % 7; // Monday = 0, Sunday = 6
  return new Date(midnight.getTime() - daysSinceMonday * 86_400_000);
}

const WEEK_MS = 7 * 86_400_000;

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function headline(asOf: Date) {
  const today = todayUtc(asOf);
  const weekStart = isoWeekStartUtc(asOf);
  const nextWeekStart = new Date(weekStart.getTime() + WEEK_MS);

  const [itemsCurrentlyOut, itemsOverdue, loansReturnedThisWeek, totalItems, archivedItems] =
    await Promise.all([
      // The partial unique index allows at most one open loan per item, so the
      // number of issued loans IS the number of items out. No DISTINCT needed.
      prisma.loan.count({ where: { status: 'issued' } }),
      prisma.loan.count({ where: { status: 'issued', dueOn: { lt: today } } }),
      prisma.loan.count({
        where: { status: 'returned', returnedAt: { gte: weekStart, lt: nextWeekStart } },
      }),
      prisma.catalogueItem.count({ where: { archivedAt: null } }),
      prisma.catalogueItem.count({ where: { archivedAt: { not: null } } }),
    ]);

  return { itemsCurrentlyOut, itemsOverdue, loansReturnedThisWeek, totalItems, archivedItems };
}

async function byStatus(): Promise<{ status: LoanStatus; count: number }[]> {
  const grouped = await prisma.loan.groupBy({ by: ['status'], _count: { _all: true } });
  const counts = new Map(grouped.map((row) => [row.status, row._count._all]));

  // Every status is present even at zero: a bar chart with a missing bar reads
  // as "no data" rather than "none".
  return ALL_STATUSES.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

/**
 * Loans per custodian.
 *
 * Raw SQL because the shape Prisma cannot express is the important one: a LEFT
 * JOIN through the custodian join table, so that a loan on an item with two
 * custodians produces two rows (one per custodian) and a loan on an item with
 * none produces a single row with a NULL custodian. That NULL is the
 * `Unassigned` bucket, and dropping it would silently lose those loans.
 */
async function byCustodian(): Promise<{ custodianId: string | null; name: string; count: number }[]> {
  const rows = await prisma.$queryRaw<
    { custodian_id: string | null; name: string; count: number }[]
  >`
    SELECT ic.librarian_id                     AS custodian_id,
           COALESCE(u.name, 'Unassigned')      AS name,
           count(*)::int                       AS count
      FROM loans l
      JOIN catalogue_items i ON i.id = l.item_id
      LEFT JOIN item_custodians ic ON ic.item_id = i.id
      LEFT JOIN users u ON u.id = ic.librarian_id
     GROUP BY ic.librarian_id, u.name
     ORDER BY (ic.librarian_id IS NULL), COALESCE(u.name, 'Unassigned'), ic.librarian_id
  `;

  return rows.map((row) => ({
    custodianId: row.custodian_id,
    name: row.name,
    count: Number(row.count),
  }));
}

/**
 * Returns per ISO week, for the current week and the seven before it.
 *
 * The series is generated rather than derived from the rows that happen to
 * exist. A plain GROUP BY over returns produces only the weeks that had one, so
 * a quiet fortnight silently shortens the chart from eight bars to six and
 * nothing looks wrong. `generate_series` fixes the buckets; the LEFT JOIN fills
 * them, with zero where there is nothing.
 *
 * Both boundaries come from the caller's single `asOf`, not from the database
 * clock, so the last bucket is exactly the "returned this week" headline.
 */
async function returnsPerWeek(asOf: Date): Promise<{ weekStart: string; count: number }[]> {
  const currentWeekStart = isoWeekStartUtc(asOf);
  const firstWeekStart = new Date(currentWeekStart.getTime() - (CHART_WEEKS - 1) * WEEK_MS);

  const rows = await prisma.$queryRaw<{ week_start: Date; count: number }[]>`
    WITH weeks AS (
      SELECT generate_series(
               ${firstWeekStart}::timestamptz,
               ${currentWeekStart}::timestamptz,
               interval '1 week'
             ) AS week_start
    )
    SELECT w.week_start,
           count(l.id)::int AS count
      FROM weeks w
      LEFT JOIN loans l
        ON l.status = 'returned'
       AND l.returned_at >= w.week_start
       AND l.returned_at <  w.week_start + interval '1 week'
     GROUP BY w.week_start
     ORDER BY w.week_start
  `;

  return rows.map((row) => ({
    weekStart: isoDate(new Date(row.week_start)),
    count: Number(row.count),
  }));
}

export async function buildDashboard(asOf: Date = new Date()): Promise<DashboardView> {
  const [headlineNumbers, statuses, custodians, weeks] = await Promise.all([
    headline(asOf),
    byStatus(),
    byCustodian(),
    returnsPerWeek(asOf),
  ]);

  return {
    asOf: asOf.toISOString(),
    headline: headlineNumbers,
    byStatus: statuses,
    byCustodian: custodians,
    returnsPerWeek: weeks,
  };
}
