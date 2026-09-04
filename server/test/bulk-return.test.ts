import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { adminPrisma } from './admin.js';
import { loginAs, seedItem } from './helpers/items.js';
import { dateString, directIssue, requestLoan, returnLoan } from './helpers/loans.js';
import {
  createLibrarian,
  createMember,
  LIBRARIAN_PASSWORD,
  MEMBER_PASSWORD,
} from './helpers/users.js';

/**
 * POST /api/loans/bulk-return.
 *
 * The module under test contains no business rules of its own — it calls the
 * same `returnLoan()` the single-loan endpoint calls. These tests check the
 * bulk semantics (per-loan results, independence, duplicate rejection) and that
 * the shared rules really are shared.
 */

const app = createApp();

type LoanResult = { loanId: string; ok: boolean; status?: string; code?: string; message?: string };

let librarianId: string;
let memberId: string;
let librarianCookie: string;
let memberCookie: string;

beforeEach(async () => {
  librarianId = (await createLibrarian('alex@test.local')).id;
  memberId = (await createMember('sam@test.local')).id;
  librarianCookie = await loginAs(app, 'alex@test.local', LIBRARIAN_PASSWORD);
  memberCookie = await loginAs(app, 'sam@test.local', MEMBER_PASSWORD);
});

function bulkReturn(cookie: string, body: Record<string, unknown>) {
  return request(app).post('/api/loans/bulk-return').set('Cookie', cookie).send(body);
}

/** An issued loan on a fresh item, so the one-open-loan rule is never in play. */
async function issuedLoanOnNewItem(code: string): Promise<string> {
  const item = await seedItem(librarianId, { code });
  const response = await directIssue(app, librarianCookie, {
    itemId: item.id,
    borrowerId: memberId,
    dueOn: dateString(7),
  });
  return response.body.loan.id as string;
}

describe('authorization', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const loanId = await issuedLoanOnNewItem('AUTH-1');
    const response = await request(app).post('/api/loans/bulk-return').send({ loanIds: [loanId] });

    expect(response.status).toBe(401);
  });

  it('rejects a member with 403 and returns nothing', async () => {
    const loanId = await issuedLoanOnNewItem('AUTH-2');

    const response = await bulkReturn(memberCookie, { loanIds: [loanId] });

    expect(response.status).toBe(403);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe('issued');
  });
});

describe('per-loan results', () => {
  it('reports each loan independently, and one failure does not stop the rest', async () => {
    const issuedA = await issuedLoanOnNewItem('MIX-1');
    const issuedB = await issuedLoanOnNewItem('MIX-2');

    const alreadyReturned = await issuedLoanOnNewItem('MIX-3');
    await returnLoan(app, librarianCookie, alreadyReturned);

    const lost = await issuedLoanOnNewItem('MIX-4');
    await request(app).post(`/api/loans/${lost}/lost`).set('Cookie', librarianCookie).send({});

    const requestedItem = await seedItem(librarianId, { code: 'MIX-5' });
    const requested = (await requestLoan(app, memberCookie, requestedItem.id)).body.loan.id;

    const missing = '11111111-1111-4111-8111-111111111111';

    const response = await bulkReturn(librarianCookie, {
      loanIds: [issuedA, alreadyReturned, lost, requested, missing, issuedB],
    });

    expect(response.status).toBe(200);
    expect(response.body.returned).toBe(2);
    expect(response.body.failed).toBe(4);

    const byId = new Map<string, LoanResult>(
      (response.body.results as LoanResult[]).map((r) => [r.loanId, r]),
    );

    expect(byId.get(issuedA)).toMatchObject({ ok: true, status: 'returned' });
    expect(byId.get(issuedB)).toMatchObject({ ok: true, status: 'returned' });
    // The brief's own example failure, produced by the shared service.
    expect(byId.get(alreadyReturned)).toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(byId.get(alreadyReturned)!.message).toMatch(/already been returned/);
    expect(byId.get(lost)).toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(byId.get(requested)).toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(byId.get(missing)).toMatchObject({ ok: false, code: 'not_found' });

    // The successful returns really committed.
    for (const id of [issuedA, issuedB]) {
      expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).status).toBe('returned');
    }
    // And the untouched ones kept their state.
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: requested } })).status).toBe(
      'requested',
    );
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: lost } })).status).toBe('lost');
  });

  it('preserves the order of the request in the results', async () => {
    const first = await issuedLoanOnNewItem('ORD-1');
    const second = await issuedLoanOnNewItem('ORD-2');

    const response = await bulkReturn(librarianCookie, { loanIds: [second, first] });

    expect((response.body.results as LoanResult[]).map((r) => r.loanId)).toEqual([second, first]);
  });
});

describe('the shared transition service is genuinely shared', () => {
  it('writes exactly one returned event per loan, actored by the librarian', async () => {
    const loanId = await issuedLoanOnNewItem('EV-1');

    await bulkReturn(librarianCookie, { loanIds: [loanId], note: 'Friday batch' });

    const events = await prisma.loanEvent.findMany({ where: { loanId }, orderBy: { createdAt: 'asc' } });
    const returned = events.filter((e) => e.type === 'returned');

    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ actorId: librarianId, note: 'Friday batch' });
  });

  it('writes no event for a loan it refused', async () => {
    const loanId = await issuedLoanOnNewItem('EV-2');
    await returnLoan(app, librarianCookie, loanId);
    const before = await prisma.loanEvent.count({ where: { loanId } });

    await bulkReturn(librarianCookie, { loanIds: [loanId] });

    expect(await prisma.loanEvent.count({ where: { loanId } })).toBe(before);
  });

  it('applies the same note validation as a single return', async () => {
    const loanId = await issuedLoanOnNewItem('EV-3');

    const blank = await bulkReturn(librarianCookie, { loanIds: [loanId], note: '   ' });
    expect(blank.status).toBe(400);

    const tooLong = await bulkReturn(librarianCookie, { loanIds: [loanId], note: 'x'.repeat(1001) });
    expect(tooLong.status).toBe(400);

    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe('issued');
  });
});

describe('request validation', () => {
  it('rejects a repeated loan id with 400 rather than deduplicating it', async () => {
    const loanId = await issuedLoanOnNewItem('DUP-1');

    const response = await bulkReturn(librarianCookie, { loanIds: [loanId, loanId] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('duplicate_loan_id');
    expect(response.body.error.details[0].message).toContain(loanId);

    // Nothing was returned: the request was rejected before any work started.
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe('issued');
  });

  it('rejects an empty list, a malformed id and an over-long list', async () => {
    expect((await bulkReturn(librarianCookie, { loanIds: [] })).status).toBe(400);
    expect((await bulkReturn(librarianCookie, { loanIds: ['nope'] })).status).toBe(400);
    expect((await bulkReturn(librarianCookie, { loanIds: null })).status).toBe(400);

    const tooMany = Array.from(
      { length: 201 },
      (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
    );
    expect((await bulkReturn(librarianCookie, { loanIds: tooMany })).status).toBe(400);
  });

  it('rejects unknown fields', async () => {
    const loanId = await issuedLoanOnNewItem('STRICT-1');
    const response = await bulkReturn(librarianCookie, { loanIds: [loanId], actorId: memberId });

    expect(response.status).toBe(400);
  });
});

describe('racing a single return', () => {
  it('lets exactly one of a bulk return and a single return win, writing one event', async () => {
    const loanId = await issuedLoanOnNewItem('RACE-1');

    const [bulk, single] = await Promise.all([
      bulkReturn(librarianCookie, { loanIds: [loanId] }),
      returnLoan(app, librarianCookie, loanId),
    ]);

    // The bulk endpoint always answers 200 — its per-loan result carries the
    // outcome — so the winner is decided by the result, not the status code.
    expect(bulk.status).toBe(200);
    const bulkResult = (bulk.body.results as LoanResult[])[0]!;
    const bulkWon = bulkResult.ok;
    const singleWon = single.status === 200;

    expect(bulkWon !== singleWon, 'exactly one of the two must have returned the loan').toBe(true);

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
    expect(loan.status).toBe('returned');

    // The conditional UPDATE inside returnLoan is what makes this hold: the
    // loser matched zero rows and rolled back before writing anything.
    const returnedEvents = await prisma.loanEvent.findMany({
      where: { loanId, type: 'returned' },
    });
    expect(returnedEvents).toHaveLength(1);
  });

  it('holds when two bulk returns cover the same loan', async () => {
    const loanId = await issuedLoanOnNewItem('RACE-2');

    const [first, second] = await Promise.all([
      bulkReturn(librarianCookie, { loanIds: [loanId] }),
      bulkReturn(librarianCookie, { loanIds: [loanId] }),
    ]);

    const outcomes = [
      (first.body.results as LoanResult[])[0]!.ok,
      (second.body.results as LoanResult[])[0]!.ok,
    ].sort();

    expect(outcomes).toEqual([false, true]);
    expect(await prisma.loanEvent.count({ where: { loanId, type: 'returned' } })).toBe(1);
  });
});

/**
 * Deterministic proof that the conditional UPDATE is what decides the race.
 *
 * The `Promise.all` tests above assert the right outcome, but they depend on the
 * two requests actually overlapping. Measured: with `returnLoan` mutated into a
 * read-then-write, the bulk-versus-single test still passed — the two simply did
 * not interleave that run. Only the bulk-versus-bulk test caught it.
 *
 * This test removes the timing entirely. A second connection returns the loan
 * inside a transaction and holds it open, so by the time the bulk request's
 * UPDATE runs, the loan has been returned by someone else. The conditional
 * `WHERE ... AND status = 'issued'` then matches zero rows and the bulk request
 * refuses. A read-then-write implementation reads the pre-commit row, sees
 * `issued`, and returns the loan a second time — which is what the event count
 * detects.
 */
describe('the conditional UPDATE, proven without relying on timing', () => {
  it('refuses a bulk return whose loan was returned by a transaction committing first', async () => {
    const loanId = await issuedLoanOnNewItem('DET-1');

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = adminPrisma
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`
            UPDATE loans
               SET status = 'returned', returned_at = now(), returned_by = ${librarianId}::uuid
             WHERE id = ${loanId}::uuid
          `;
          await tx.loanEvent.create({
            data: { loanId, type: 'returned', actorId: librarianId, note: 'won the race' },
          });
          await held;
        },
        { timeout: 20_000, maxWait: 20_000 },
      )
      .then(() => undefined);

    // Give the holding transaction a moment to take the row lock.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // `.then()` is what dispatches a supertest request — the Test object is
    // lazy. Without it the request would not start until the `await` below, by
    // which point the holder has committed and the race never happens. That
    // mistake made an earlier version of this test pass against a deliberately
    // broken implementation.
    const pending = bulkReturn(librarianCookie, { loanIds: [loanId] }).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;

    const response = await pending;
    const result = (response.body.results as LoanResult[])[0]!;

    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_transition');

    // The decisive assertion: the loan was returned exactly once.
    const returnedEvents = await adminPrisma.loanEvent.findMany({
      where: { loanId, type: 'returned' },
    });
    expect(returnedEvents).toHaveLength(1);
    expect(returnedEvents[0]!.note).toBe('won the race');
  });
});
