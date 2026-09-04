import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { isoWeekStartUtc } from '../src/dashboard/service.js';
import { prisma } from '../src/db.js';
import { loginAs, seedItem } from './helpers/items.js';
import {
  createLibrarian,
  createMember,
  LIBRARIAN_PASSWORD,
  MEMBER_PASSWORD,
} from './helpers/users.js';

/**
 * GET /api/dashboard — goal 8.
 *
 * Fixtures are built through Prisma rather than the lifecycle API: these tests
 * are about aggregation, and driving a dozen loans into a dozen states through
 * the transition endpoints would be slow and would couple a reporting test to
 * behaviour that has its own suite.
 */

const app = createApp();

type Dashboard = {
  headline: {
    itemsCurrentlyOut: number;
    itemsOverdue: number;
    loansReturnedThisWeek: number;
    totalItems: number;
    archivedItems: number;
  };
  byStatus: { status: string; count: number }[];
  byCustodian: { custodianId: string | null; name: string; count: number }[];
  returnsPerWeek: { weekStart: string; count: number }[];
};

const DAY = 86_400_000;

let alexId: string;
let priyaId: string;
let memberId: string;
let librarianCookie: string;
let memberCookie: string;

beforeEach(async () => {
  alexId = (await createLibrarian('alex@test.local')).id;
  priyaId = (await createLibrarian('priya@test.local')).id;
  memberId = (await createMember('sam@test.local')).id;
  librarianCookie = await loginAs(app, 'alex@test.local', LIBRARIAN_PASSWORD);
  memberCookie = await loginAs(app, 'sam@test.local', MEMBER_PASSWORD);
});

function dayOffset(days: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + days * DAY);
}

/** Creates a loan directly, with every timestamp from one clock. */
async function seedLoan(options: {
  code: string;
  status: 'requested' | 'issued' | 'returned' | 'lost';
  dueInDays?: number;
  returnedAt?: Date;
  custodians?: string[];
}) {
  const item = await seedItem(alexId, { code: options.code });
  if (options.custodians?.length) {
    await prisma.itemCustodian.createMany({
      data: options.custodians.map((librarianId) => ({ itemId: item.id, librarianId })),
    });
  }

  // Derived from the closing timestamp, not hardcoded: a loan returned nine
  // weeks ago cannot have been requested forty days ago, and the chronology
  // CHECK constraint rejects the row if it is. It caught this fixture.
  const closedAt = options.returnedAt ?? new Date();
  const requestedAt = new Date(Math.min(Date.now() - 40 * DAY, closedAt.getTime() - 7 * DAY));
  const issued = options.status !== 'requested';

  await prisma.loan.create({
    data: {
      itemId: item.id,
      borrowerId: memberId,
      status: options.status,
      requestedAt,
      issuedAt: issued ? requestedAt : null,
      dueOn: issued ? dayOffset(options.dueInDays ?? 7) : null,
      returnedAt: options.status === 'returned' ? (options.returnedAt ?? new Date()) : null,
      lostAt: options.status === 'lost' ? new Date() : null,
    },
  });
  return item;
}

async function fetchDashboard(): Promise<Dashboard> {
  const response = await request(app).get('/api/dashboard').set('Cookie', librarianCookie);
  expect(response.status).toBe(200);
  return response.body as Dashboard;
}

describe('authorization', () => {
  it('rejects an unauthenticated request with 401', async () => {
    expect((await request(app).get('/api/dashboard')).status).toBe(401);
  });

  it('rejects a member with 403', async () => {
    const response = await request(app).get('/api/dashboard').set('Cookie', memberCookie);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });
});

describe('headline numbers', () => {
  it('counts items currently out as the issued loans', async () => {
    await seedLoan({ code: 'OUT-1', status: 'issued', dueInDays: 7 });
    await seedLoan({ code: 'OUT-2', status: 'issued', dueInDays: -3 });
    await seedLoan({ code: 'BACK-1', status: 'returned' });
    await seedLoan({ code: 'WAIT-1', status: 'requested' });

    const dashboard = await fetchDashboard();

    expect(dashboard.headline.itemsCurrentlyOut).toBe(2);
  });

  it('counts overdue as issued and past due, with today excluded', async () => {
    await seedLoan({ code: 'DUE-TODAY', status: 'issued', dueInDays: 0 });
    await seedLoan({ code: 'DUE-YESTERDAY', status: 'issued', dueInDays: -1 });
    await seedLoan({ code: 'DUE-LATER', status: 'issued', dueInDays: 5 });
    // A returned loan long past its date is not overdue: it has come back.
    await seedLoan({ code: 'LATE-BACK', status: 'returned', dueInDays: -40 });

    const dashboard = await fetchDashboard();

    expect(dashboard.headline.itemsOverdue).toBe(1);
  });

  it('separates active and archived catalogue totals', async () => {
    await seedItem(alexId, { code: 'ACTIVE-1' });
    await seedItem(alexId, { code: 'ACTIVE-2' });
    await seedItem(alexId, { code: 'GONE-1', archivedAt: new Date() });

    const dashboard = await fetchDashboard();

    expect(dashboard.headline.totalItems).toBe(2);
    expect(dashboard.headline.archivedItems).toBe(1);
  });
});

describe('returned this week', () => {
  it('counts returns from the ISO Monday onwards, and excludes the week before', async () => {
    const weekStart = isoWeekStartUtc(new Date());

    // One second before this week began — belongs to the previous week.
    await seedLoan({
      code: 'PREV-1',
      status: 'returned',
      returnedAt: new Date(weekStart.getTime() - 1000),
    });
    // Exactly at the Monday boundary — belongs to this week.
    await seedLoan({ code: 'THIS-1', status: 'returned', returnedAt: weekStart });
    await seedLoan({
      code: 'THIS-2',
      status: 'returned',
      returnedAt: new Date(weekStart.getTime() + 1000),
    });

    const dashboard = await fetchDashboard();

    expect(dashboard.headline.loansReturnedThisWeek).toBe(2);
  });

  it('agrees exactly with the final bucket of the chart', async () => {
    const weekStart = isoWeekStartUtc(new Date());
    await seedLoan({ code: 'AGREE-1', status: 'returned', returnedAt: weekStart });
    await seedLoan({
      code: 'AGREE-2',
      status: 'returned',
      returnedAt: new Date(weekStart.getTime() - 1000),
    });

    const dashboard = await fetchDashboard();
    const lastBucket = dashboard.returnsPerWeek.at(-1)!;

    // Both come from the same asOf, so a disagreement here would mean the
    // headline and the chart were computed against different clocks.
    expect(lastBucket.count).toBe(dashboard.headline.loansReturnedThisWeek);
    expect(lastBucket.weekStart).toBe(weekStart.toISOString().slice(0, 10));
  });
});

describe('breakdown by status', () => {
  it('reports the four real statuses and no fifth', async () => {
    await seedLoan({ code: 'S-1', status: 'requested' });
    await seedLoan({ code: 'S-2', status: 'issued', dueInDays: 5 });
    await seedLoan({ code: 'S-3', status: 'issued', dueInDays: -5 }); // overdue
    await seedLoan({ code: 'S-4', status: 'returned' });
    await seedLoan({ code: 'S-5', status: 'lost' });

    const dashboard = await fetchDashboard();

    expect(dashboard.byStatus.map((row) => row.status)).toEqual([
      'requested',
      'issued',
      'returned',
      'lost',
    ]);
    // Overdue is a subset of issued, not a bucket. Both issued loans are here.
    expect(dashboard.byStatus.find((row) => row.status === 'issued')!.count).toBe(2);
    expect(dashboard.byStatus.some((row) => row.status === 'overdue')).toBe(false);
  });

  it('reports zero for a status with no loans rather than omitting it', async () => {
    await seedLoan({ code: 'ONLY-1', status: 'issued', dueInDays: 3 });

    const dashboard = await fetchDashboard();

    expect(dashboard.byStatus).toHaveLength(4);
    expect(dashboard.byStatus.find((row) => row.status === 'lost')!.count).toBe(0);
  });

  it('sums to the total number of loans', async () => {
    await seedLoan({ code: 'T-1', status: 'requested' });
    await seedLoan({ code: 'T-2', status: 'issued', dueInDays: 1 });
    await seedLoan({ code: 'T-3', status: 'returned' });

    const dashboard = await fetchDashboard();
    const sum = dashboard.byStatus.reduce((total, row) => total + row.count, 0);

    expect(sum).toBe(await prisma.loan.count());
  });
});

describe('breakdown by custodian', () => {
  it('counts a loan under every custodian of its item', async () => {
    // The trap: an item with two custodians. Counting it once would understate
    // one of them; picking a "primary" would invent a rule the brief has not.
    await seedLoan({ code: 'TWO-1', status: 'issued', dueInDays: 5, custodians: [alexId, priyaId] });

    const dashboard = await fetchDashboard();
    const byId = new Map(dashboard.byCustodian.map((row) => [row.custodianId, row.count]));

    // Keyed on id, not name: the fixture librarians share a display name, and a
    // name-keyed assertion would collapse them and pass for the wrong reason.
    expect(byId.get(alexId)).toBe(1);
    expect(byId.get(priyaId)).toBe(1);
    expect(dashboard.byCustodian.filter((row) => row.custodianId !== null)).toHaveLength(2);
  });

  it('puts loans on items with no custodian into Unassigned', async () => {
    // The other trap: without this bucket these loans vanish from the
    // breakdown entirely and nothing looks wrong.
    await seedLoan({ code: 'NONE-1', status: 'issued', dueInDays: 5 });
    await seedLoan({ code: 'NONE-2', status: 'returned' });
    await seedLoan({ code: 'HAS-1', status: 'issued', dueInDays: 5, custodians: [alexId] });

    const dashboard = await fetchDashboard();
    const unassigned = dashboard.byCustodian.find((row) => row.custodianId === null);

    expect(unassigned).toBeDefined();
    expect(unassigned!.name).toBe('Unassigned');
    expect(unassigned!.count).toBe(2);
  });

  it('counts all loans, not only open ones', async () => {
    await seedLoan({ code: 'ALL-1', status: 'requested', custodians: [alexId] });
    await seedLoan({ code: 'ALL-2', status: 'issued', dueInDays: 5, custodians: [alexId] });
    await seedLoan({ code: 'ALL-3', status: 'returned', custodians: [alexId] });
    await seedLoan({ code: 'ALL-4', status: 'lost', custodians: [alexId] });

    const dashboard = await fetchDashboard();
    const alex = dashboard.byCustodian.find((row) => row.custodianId === alexId);

    expect(alex!.count).toBe(4);
  });

  it('may exceed the loan total, because custodianship is many-to-many', async () => {
    await seedLoan({ code: 'M-1', status: 'issued', dueInDays: 5, custodians: [alexId, priyaId] });

    const dashboard = await fetchDashboard();
    const sum = dashboard.byCustodian.reduce((total, row) => total + row.count, 0);

    // One loan, two custodians, two counts. This is the intended semantics, not
    // double counting to be corrected.
    expect(await prisma.loan.count()).toBe(1);
    expect(sum).toBe(2);
  });

  it('lists Unassigned last', async () => {
    await seedLoan({ code: 'ORD-1', status: 'issued', dueInDays: 5 });
    await seedLoan({ code: 'ORD-2', status: 'issued', dueInDays: 5, custodians: [alexId] });

    const dashboard = await fetchDashboard();

    expect(dashboard.byCustodian.at(-1)!.custodianId).toBeNull();
  });
});

describe('the eight-week chart', () => {
  it('always has exactly eight buckets, oldest first, current week last', async () => {
    const dashboard = await fetchDashboard();
    const weekStart = isoWeekStartUtc(new Date());

    expect(dashboard.returnsPerWeek).toHaveLength(8);
    expect(dashboard.returnsPerWeek.at(-1)!.weekStart).toBe(
      weekStart.toISOString().slice(0, 10),
    );

    const starts = dashboard.returnsPerWeek.map((bucket) => bucket.weekStart);
    expect(starts).toEqual([...starts].sort());
  });

  it('includes weeks with no returns as zero rather than omitting them', async () => {
    const weekStart = isoWeekStartUtc(new Date());
    // Returns in only two of the eight weeks.
    await seedLoan({ code: 'W0-1', status: 'returned', returnedAt: weekStart });
    await seedLoan({
      code: 'W3-1',
      status: 'returned',
      returnedAt: new Date(weekStart.getTime() - 3 * 7 * DAY + DAY),
    });

    const dashboard = await fetchDashboard();

    // A GROUP BY over existing rows would return two buckets and the chart
    // would silently shrink.
    expect(dashboard.returnsPerWeek).toHaveLength(8);
    expect(dashboard.returnsPerWeek.filter((bucket) => bucket.count === 0)).toHaveLength(6);
    expect(dashboard.returnsPerWeek.at(-1)!.count).toBe(1);
    expect(dashboard.returnsPerWeek.at(-4)!.count).toBe(1);
  });

  it('places every bucket on a Monday', async () => {
    const dashboard = await fetchDashboard();

    for (const bucket of dashboard.returnsPerWeek) {
      expect(new Date(`${bucket.weekStart}T00:00:00.000Z`).getUTCDay()).toBe(1);
    }
  });

  it('excludes a return older than the eight-week window', async () => {
    const weekStart = isoWeekStartUtc(new Date());
    await seedLoan({
      code: 'ANCIENT-1',
      status: 'returned',
      returnedAt: new Date(weekStart.getTime() - 9 * 7 * DAY),
    });

    const dashboard = await fetchDashboard();

    expect(dashboard.returnsPerWeek.reduce((total, b) => total + b.count, 0)).toBe(0);
  });

  it('assigns a Sunday return to that week and the following Monday to the next', async () => {
    const weekStart = isoWeekStartUtc(new Date());
    const lastWeekStart = new Date(weekStart.getTime() - 7 * DAY);
    // 23:59:59 on the Sunday that ends the previous week.
    const sunday = new Date(weekStart.getTime() - 1000);

    await seedLoan({ code: 'SUN-1', status: 'returned', returnedAt: sunday });
    await seedLoan({ code: 'MON-1', status: 'returned', returnedAt: weekStart });

    const dashboard = await fetchDashboard();
    const byWeek = new Map(dashboard.returnsPerWeek.map((b) => [b.weekStart, b.count]));

    expect(byWeek.get(lastWeekStart.toISOString().slice(0, 10))).toBe(1);
    expect(byWeek.get(weekStart.toISOString().slice(0, 10))).toBe(1);
  });
});
