import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { isOverdue } from '../src/loans/views.js';
import { loginAs, seedItem } from './helpers/items.js';
import { dateString } from './helpers/loans.js';
import {
  createLibrarian,
  createMember,
  LIBRARIAN_PASSWORD,
  MEMBER_PASSWORD,
} from './helpers/users.js';

/**
 * GET /api/loans — goal 6.
 *
 * The fixture is built directly through Prisma rather than through the loan
 * endpoints. That is deliberate: these tests are about querying, and driving
 * twelve loans into twelve different states through the lifecycle API would
 * make them slow and would couple a query test to transition behaviour that has
 * its own suite.
 */

const app = createApp();

type Row = {
  id: string;
  status: string;
  isOverdue: boolean;
  dueOn: string | null;
  item: { title: string; code: string };
  borrower: { name: string; email: string };
};

let librarianId: string;
let samId: string;
let danaId: string;
let librarianCookie: string;
let samCookie: string;
let danaCookie: string;
let cameraId: string;
let drillId: string;

/** Creates a loan in a given state, with all timestamps from one clock. */
async function seedLoan(options: {
  itemId: string;
  borrowerId: string;
  status: 'requested' | 'issued' | 'returned' | 'lost';
  dueInDays?: number;
  requestedDaysAgo?: number;
}) {
  const now = new Date();
  const requestedAt = new Date(now.getTime() - (options.requestedDaysAgo ?? 1) * 86_400_000);
  const issued = options.status !== 'requested';
  const dueOn =
    options.dueInDays === undefined
      ? null
      : new Date(`${dateString(options.dueInDays)}T00:00:00.000Z`);

  return prisma.loan.create({
    data: {
      itemId: options.itemId,
      borrowerId: options.borrowerId,
      status: options.status,
      requestedAt,
      issuedAt: issued ? requestedAt : null,
      dueOn: issued ? dueOn : null,
      returnedAt: options.status === 'returned' ? now : null,
      lostAt: options.status === 'lost' ? now : null,
    },
  });
}

beforeEach(async () => {
  librarianId = (await createLibrarian('alex@test.local')).id;
  samId = (await createMember('sam@test.local')).id;
  danaId = (await createMember('dana@test.local')).id;
  librarianCookie = await loginAs(app, 'alex@test.local', LIBRARIAN_PASSWORD);
  samCookie = await loginAs(app, 'sam@test.local', MEMBER_PASSWORD);
  danaCookie = await loginAs(app, 'dana@test.local', MEMBER_PASSWORD);

  cameraId = (await seedItem(librarianId, { title: 'Canon EOS R6', code: 'CAM-001' })).id;
  drillId = (await seedItem(librarianId, { title: 'DeWalt drill', code: 'TOOL-001' })).id;
});

function list(cookie: string, query = '') {
  return request(app).get(`/api/loans${query}`).set('Cookie', cookie);
}

describe('authorization and scoping', () => {
  it('rejects an unauthenticated request with 401', async () => {
    expect((await request(app).get('/api/loans')).status).toBe(401);
  });

  it('shows a librarian every loan in the system', async () => {
    await seedLoan({ itemId: cameraId, borrowerId: samId, status: 'issued', dueInDays: 7 });
    await seedLoan({ itemId: drillId, borrowerId: danaId, status: 'issued', dueInDays: 7 });

    const response = await list(librarianCookie);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
  });

  it('shows a member only their own loans', async () => {
    await seedLoan({ itemId: cameraId, borrowerId: samId, status: 'issued', dueInDays: 7 });
    await seedLoan({ itemId: drillId, borrowerId: danaId, status: 'issued', dueInDays: 7 });

    const response = await list(samCookie);

    expect(response.body.total).toBe(1);
    expect(response.body.rows.map((r: Row) => r.borrower.name)).toEqual(['Test Member']);
  });

  it("ignores a borrowerId a member supplies, rather than honouring it", async () => {
    await seedLoan({ itemId: cameraId, borrowerId: samId, status: 'issued', dueInDays: 7 });
    await seedLoan({ itemId: drillId, borrowerId: danaId, status: 'issued', dueInDays: 7 });

    // Sam asking for Dana's loans gets Sam's, not Dana's and not both.
    const response = await list(samCookie, `?borrowerId=${danaId}`);

    expect(response.body.total).toBe(1);
    expect(response.body.rows[0].item.code).toBe('CAM-001');
  });

  it('lets a librarian filter by borrowerId for real', async () => {
    await seedLoan({ itemId: cameraId, borrowerId: samId, status: 'issued', dueInDays: 7 });
    await seedLoan({ itemId: drillId, borrowerId: danaId, status: 'issued', dueInDays: 7 });

    const response = await list(librarianCookie, `?borrowerId=${danaId}`);

    expect(response.body.total).toBe(1);
    expect(response.body.rows[0].item.code).toBe('TOOL-001');
  });

  it('returns an empty list rather than an error when a member has no loans', async () => {
    const response = await list(danaCookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ rows: [], total: 0, page: 1, pageSize: 20 });
  });
});

describe('search', () => {
  beforeEach(async () => {
    await seedLoan({ itemId: cameraId, borrowerId: samId, status: 'issued', dueInDays: 7 });
    await seedLoan({ itemId: drillId, borrowerId: danaId, status: 'issued', dueInDays: 7 });
  });

  it('matches on item title, partially and case-insensitively', async () => {
    for (const term of ['Canon', 'canon', 'CANON', 'anon', 'EOS'] as const) {
      const response = await list(librarianCookie, `?search=${term}`);
      expect(response.body.rows.map((r: Row) => r.item.code), term).toEqual(['CAM-001']);
    }
  });

  it('matches on borrower name', async () => {
    const response = await list(librarianCookie, '?search=Test%20Member');
    expect(response.body.total).toBe(2); // both borrowers are named "Test Member"

    const byExact = await list(librarianCookie, '?search=dana@test.local');
    expect(byExact.body.rows.map((r: Row) => r.item.code)).toEqual(['TOOL-001']);
  });

  it('matches on borrower email, partially and case-insensitively', async () => {
    for (const term of ['dana@', 'DANA@TEST', 'test.local'] as const) {
      const response = await list(librarianCookie, `?search=${encodeURIComponent(term)}`);
      expect(response.body.total, term).toBeGreaterThan(0);
    }

    const specific = await list(librarianCookie, '?search=sam%40test.local');
    expect(specific.body.rows.map((r: Row) => r.item.code)).toEqual(['CAM-001']);
  });

  it('returns an empty page with a zero total when nothing matches', async () => {
    const response = await list(librarianCookie, '?search=nothingmatchesthis');

    expect(response.status).toBe(200);
    expect(response.body.rows).toEqual([]);
    expect(response.body.total).toBe(0);
  });

  it('does not search the item code, which the catalogue list covers', async () => {
    const response = await list(librarianCookie, '?search=TOOL-001');
    expect(response.body.total).toBe(0);
  });

  it('narrows a member search to their own loans as well', async () => {
    const response = await list(samCookie, '?search=test.local');

    expect(response.body.total).toBe(1);
    expect(response.body.rows[0].item.code).toBe('CAM-001');
  });
});

describe('filters', () => {
  beforeEach(async () => {
    await seedLoan({ itemId: cameraId, borrowerId: samId, status: 'requested' });
    await seedLoan({ itemId: drillId, borrowerId: samId, status: 'issued', dueInDays: 7 });
    const third = await seedItem(librarianId, { code: 'X-3' });
    await seedLoan({ itemId: third.id, borrowerId: danaId, status: 'issued', dueInDays: -4 });
    const fourth = await seedItem(librarianId, { code: 'X-4' });
    await seedLoan({ itemId: fourth.id, borrowerId: danaId, status: 'returned', dueInDays: -10 });
    const fifth = await seedItem(librarianId, { code: 'X-5' });
    await seedLoan({ itemId: fifth.id, borrowerId: danaId, status: 'lost', dueInDays: -20 });
  });

  it('filters by each real status', async () => {
    const expected: Record<string, number> = { requested: 1, issued: 2, returned: 1, lost: 1 };

    for (const [status, count] of Object.entries(expected)) {
      const response = await list(librarianCookie, `?status=${status}`);
      expect(response.body.total, status).toBe(count);
      expect(response.body.rows.every((r: Row) => r.status === status)).toBe(true);
    }
  });

  it('treats overdue as a subset of issued, not a fifth status', async () => {
    const issued = await list(librarianCookie, '?status=issued');
    const overdue = await list(librarianCookie, '?status=overdue');

    // An overdue loan IS issued, so `issued` must include it.
    expect(issued.body.total).toBe(2);
    expect(overdue.body.total).toBe(1);

    const overdueIds = overdue.body.rows.map((r: Row) => r.id);
    const issuedIds = issued.body.rows.map((r: Row) => r.id);
    expect(issuedIds).toEqual(expect.arrayContaining(overdueIds));

    // And every row the overdue filter returned really is overdue.
    expect(overdue.body.rows.every((r: Row) => r.isOverdue)).toBe(true);
    expect(overdue.body.rows.every((r: Row) => r.status === 'issued')).toBe(true);
  });

  it('does not count a returned or lost loan as overdue, however late it was', async () => {
    for (const status of ['returned', 'lost'] as const) {
      const response = await list(librarianCookie, `?status=${status}`);
      expect(response.body.rows.every((r: Row) => r.isOverdue === false), status).toBe(true);
    }
  });

  it('filters by item', async () => {
    const response = await list(librarianCookie, `?itemId=${drillId}`);

    expect(response.body.total).toBe(1);
    expect(response.body.rows[0].item.code).toBe('TOOL-001');
  });

  it('combines search, status and borrower', async () => {
    const response = await list(
      librarianCookie,
      `?status=issued&borrowerId=${samId}&search=DeWalt`,
    );

    expect(response.body.total).toBe(1);
    expect(response.body.rows[0].item.code).toBe('TOOL-001');
  });

  it('rejects an unknown status value', async () => {
    const response = await list(librarianCookie, '?status=banana');
    expect(response.status).toBe(400);
  });

  it('rejects a malformed uuid filter', async () => {
    expect((await list(librarianCookie, '?itemId=not-a-uuid')).status).toBe(400);
    expect((await list(librarianCookie, '?borrowerId=not-a-uuid')).status).toBe(400);
  });
});

describe('the overdue boundary matches milestone 4 exactly', () => {
  it('treats due today as not overdue and due yesterday as overdue', async () => {
    await seedLoan({ itemId: cameraId, borrowerId: samId, status: 'issued', dueInDays: 0 });
    await seedLoan({ itemId: drillId, borrowerId: danaId, status: 'issued', dueInDays: -1 });

    const overdue = await list(librarianCookie, '?status=overdue');

    expect(overdue.body.total).toBe(1);
    expect(overdue.body.rows[0].item.code).toBe('TOOL-001');

    const all = await list(librarianCookie, '?status=issued');
    const dueToday = all.body.rows.find((r: Row) => r.item.code === 'CAM-001');
    expect(dueToday.isOverdue).toBe(false);
  });

  it('agrees with the TypeScript isOverdue derivation across the whole dataset', async () => {
    // The SQL predicate and the derived flag are two expressions of one rule.
    // This is the test that fails if they ever drift apart.
    for (const offset of [-30, -1, 0, 1, 30]) {
      const item = await seedItem(librarianId, { code: `DUE${offset}` });
      await seedLoan({ itemId: item.id, borrowerId: samId, status: 'issued', dueInDays: offset });
    }
    const closed = await seedItem(librarianId, { code: 'CLOSED-1' });
    await seedLoan({ itemId: closed.id, borrowerId: samId, status: 'returned', dueInDays: -50 });

    const asOf = new Date();
    const everyLoan = await prisma.loan.findMany();
    const expectedOverdueIds = everyLoan
      .filter((loan) => isOverdue(loan, asOf))
      .map((loan) => loan.id)
      .sort();

    const response = await list(librarianCookie, '?status=overdue&pageSize=100');
    const actualOverdueIds = response.body.rows.map((r: Row) => r.id).sort();

    expect(actualOverdueIds).toEqual(expectedOverdueIds);
    expect(response.body.total).toBe(expectedOverdueIds.length);
  });
});

describe('sorting', () => {
  beforeEach(async () => {
    // One loan of each status, so status sorting has something to order.
    await seedLoan({ itemId: cameraId, borrowerId: samId, status: 'lost', dueInDays: -9, requestedDaysAgo: 1 });
    await seedLoan({ itemId: drillId, borrowerId: samId, status: 'returned', dueInDays: -3, requestedDaysAgo: 2 });
    const c = await seedItem(librarianId, { code: 'S-3' });
    await seedLoan({ itemId: c.id, borrowerId: samId, status: 'issued', dueInDays: 5, requestedDaysAgo: 3 });
    const d = await seedItem(librarianId, { code: 'S-4' });
    await seedLoan({ itemId: d.id, borrowerId: samId, status: 'requested', requestedDaysAgo: 4 });
  });

  it('sorts by status in lifecycle order, not alphabetical order', async () => {
    const asc = await list(librarianCookie, '?sort=status&dir=asc');

    // Alphabetically this would be issued, lost, requested, returned — which is
    // meaningless. The enum's declaration order gives the lifecycle instead.
    expect(asc.body.rows.map((r: Row) => r.status)).toEqual([
      'requested',
      'issued',
      'returned',
      'lost',
    ]);

    const desc = await list(librarianCookie, '?sort=status&dir=desc');
    expect(desc.body.rows.map((r: Row) => r.status)).toEqual([
      'lost',
      'returned',
      'issued',
      'requested',
    ]);
  });

  it('sorts by requested date in both directions', async () => {
    const asc = await list(librarianCookie, '?sort=requestedAt&dir=asc');
    const desc = await list(librarianCookie, '?sort=requestedAt&dir=desc');

    const ascCodes = asc.body.rows.map((r: Row) => r.item.code);
    expect(ascCodes).toEqual(['S-4', 'S-3', 'TOOL-001', 'CAM-001']);
    expect(desc.body.rows.map((r: Row) => r.item.code)).toEqual([...ascCodes].reverse());
  });

  it('sorts by due date and puts loans with no due date last in both directions', async () => {
    const asc = await list(librarianCookie, '?sort=dueOn&dir=asc');
    const desc = await list(librarianCookie, '?sort=dueOn&dir=desc');

    // The requested loan has no due date. It is not "due earlier" or "due
    // later" — it is not in the sequence — so it sits at the end either way.
    expect(asc.body.rows.map((r: Row) => r.dueOn).at(-1)).toBeNull();
    expect(desc.body.rows.map((r: Row) => r.dueOn).at(-1)).toBeNull();

    const ascDates = asc.body.rows.map((r: Row) => r.dueOn).filter(Boolean);
    expect(ascDates).toEqual([...ascDates].sort());
    const descDates = desc.body.rows.map((r: Row) => r.dueOn).filter(Boolean);
    expect(descDates).toEqual([...descDates].sort().reverse());
  });

  it('rejects an unknown sort key rather than ignoring it', async () => {
    for (const sort of ['password_hash', 'borrowerId', '1; DROP TABLE loans', 'id']) {
      const response = await list(librarianCookie, `?sort=${encodeURIComponent(sort)}`);
      expect(response.status, sort).toBe(400);
    }
  });

  it('rejects an unknown direction rather than silently defaulting', async () => {
    for (const dir of ['sideways', 'ASC', 'ascending', '1']) {
      const response = await list(librarianCookie, `?dir=${dir}`);
      expect(response.status, dir).toBe(400);
    }
  });

  it('defaults to requested date ascending when nothing is asked for', async () => {
    const explicit = await list(librarianCookie, '?sort=requestedAt&dir=asc');
    const implicit = await list(librarianCookie);

    expect(implicit.body.rows.map((r: Row) => r.id)).toEqual(
      explicit.body.rows.map((r: Row) => r.id),
    );
  });
});

describe('pagination', () => {
  beforeEach(async () => {
    // 25 loans on 25 distinct items, so the one-open-loan rule is not in play.
    for (let i = 0; i < 25; i += 1) {
      const item = await seedItem(librarianId, { code: `P-${String(i).padStart(2, '0')}` });
      await seedLoan({
        itemId: item.id,
        borrowerId: samId,
        status: 'returned',
        dueInDays: -i,
        requestedDaysAgo: i + 1,
      });
    }
  });

  it('reports the total number of matches, not the size of the page', async () => {
    const response = await list(librarianCookie, '?pageSize=10');

    expect(response.body.rows).toHaveLength(10);
    expect(response.body.total).toBe(25);
    expect(response.body.page).toBe(1);
    expect(response.body.pageSize).toBe(10);
  });

  it('is genuinely server-side: a small page of a large set stays small', async () => {
    // The brief's explicit failure mode is loading everything and filtering in
    // the browser. If that were happening, this would come back with 25 rows.
    const response = await list(librarianCookie, '?pageSize=10&page=2');

    expect(response.body.rows).toHaveLength(10);
    expect(response.body.total).toBe(25);
  });

  it('returns disjoint pages that cover the whole set', async () => {
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const response = await list(librarianCookie, `?pageSize=10&page=${page}`);
      seen.push(...response.body.rows.map((r: Row) => r.id));
    }

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('returns an empty page past the end, with the correct total', async () => {
    const response = await list(librarianCookie, '?pageSize=10&page=99');

    expect(response.status).toBe(200);
    expect(response.body.rows).toEqual([]);
    expect(response.body.total).toBe(25);
  });

  it('caps an oversized pageSize', async () => {
    const response = await list(librarianCookie, '?pageSize=100000');

    expect(response.status).toBe(200);
    expect(response.body.pageSize).toBe(100);
  });

  it('rejects nonsensical page and pageSize values', async () => {
    for (const query of [
      '?page=0',
      '?page=-1',
      '?page=abc',
      '?page=1.5',
      '?pageSize=0',
      '?pageSize=-10',
      '?pageSize=abc',
    ]) {
      expect((await list(librarianCookie, query)).status, query).toBe(400);
    }
  });

  it('applies filters before paginating, not after', async () => {
    const response = await list(librarianCookie, '?status=returned&pageSize=5');

    // If pagination ran first and the filter second, total would be a page-sized
    // number rather than the full count of matches.
    expect(response.body.rows).toHaveLength(5);
    expect(response.body.total).toBe(25);
  });

  it('is stable across repeated requests when the sort field collides', async () => {
    const first = await list(librarianCookie, '?sort=status&pageSize=10&page=1');
    const again = await list(librarianCookie, '?sort=status&pageSize=10&page=1');
    const second = await list(librarianCookie, '?sort=status&pageSize=10&page=2');

    const ids = (r: { body: { rows: Row[] } }) => r.body.rows.map((row) => row.id);

    expect(ids(first)).toEqual(ids(again));
    expect(ids(first).some((id) => ids(second).includes(id))).toBe(false);
  });

  /*
   * The test above is necessary but not sufficient, and I only found that out
   * by breaking the implementation on purpose: with the id tiebreak removed
   * entirely, all 37 tests still passed. Postgres happened to return this small
   * table in a stable order, so "stable across two requests" proved nothing.
   *
   * The assertion below does discriminate. Loan ids are random uuids, so a
   * result set ordered by anything else — insertion order, physical order, a
   * different column — is essentially never also in id order. Asserting that
   * tied rows come back in id order therefore fails deterministically when the
   * tiebreak is missing or is some other column.
   */
  it('breaks ties on loan id specifically, which is what makes paging safe', async () => {
    // Every row here has the same status AND the same requested timestamp, so
    // the requested sort field cannot separate any of them.
    await prisma.loan.deleteMany({});
    const sharedRequestedAt = new Date('2026-02-01T09:00:00.000Z');
    for (let i = 0; i < 12; i += 1) {
      const item = await seedItem(librarianId, { code: `TIE-${i}` });
      await prisma.loan.create({
        data: {
          itemId: item.id,
          borrowerId: samId,
          status: 'returned',
          requestedAt: sharedRequestedAt,
          issuedAt: sharedRequestedAt,
          dueOn: new Date('2026-02-15T00:00:00.000Z'),
          returnedAt: sharedRequestedAt,
        },
      });
    }

    const collected: string[] = [];
    for (const page of [1, 2, 3]) {
      const response = await list(librarianCookie, `?sort=status&pageSize=5&page=${page}`);
      collected.push(...response.body.rows.map((r: Row) => r.id));
    }

    expect(collected).toHaveLength(12);
    expect(new Set(collected).size).toBe(12);
    expect(collected).toEqual([...collected].sort());
  });
});

describe('the response shape', () => {
  it('carries the joined item and borrower so a table renders from one request', async () => {
    await seedLoan({ itemId: cameraId, borrowerId: samId, status: 'issued', dueInDays: 7 });

    const response = await list(librarianCookie);
    const row = response.body.rows[0];

    expect(row).toMatchObject({
      status: 'issued',
      isOverdue: false,
      item: { title: 'Canon EOS R6', code: 'CAM-001', isArchived: false },
      borrower: { name: 'Test Member', email: 'sam@test.local' },
    });
    expect(row.dueOn).not.toBeNull();
  });

  it('marks an archived item on the row without hiding the loan', async () => {
    await seedLoan({ itemId: cameraId, borrowerId: samId, status: 'issued', dueInDays: 7 });
    await request(app).post(`/api/items/${cameraId}/archive`).set('Cookie', librarianCookie);

    const response = await list(librarianCookie);

    expect(response.body.total).toBe(1);
    expect(response.body.rows[0].item.isArchived).toBe(true);
  });
});
