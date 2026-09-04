import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { adminPrisma } from './admin.js';
import { loginAs, seedItem } from './helpers/items.js';
import { dateString, directIssue, issueLoan, requestLoan, returnLoan } from './helpers/loans.js';
import {
  createLibrarian,
  createMember,
  LIBRARIAN_PASSWORD,
  MEMBER_PASSWORD,
} from './helpers/users.js';

/**
 * Races, against real Postgres.
 *
 * Every test here fires genuinely overlapping requests through the HTTP layer
 * with `Promise.all` — separate connections, separate transactions, no
 * sequencing. A test that awaited each call in turn would pass against an
 * implementation with a wide-open race and prove nothing.
 *
 * Three different mechanisms are under test, one per kind of race:
 *   - the partial unique index, for two people grabbing the same free item
 *   - the conditional UPDATE, for two people acting on the same loan
 *   - the item row lock, for a loan racing an archive
 */

const app = createApp();

let librarianId: string;
let memberId: string;
let otherMemberId: string;
let librarianCookie: string;
let memberCookie: string;
let otherMemberCookie: string;
let itemId: string;

beforeEach(async () => {
  librarianId = (await createLibrarian('alex@test.local')).id;
  memberId = (await createMember('sam@test.local')).id;
  otherMemberId = (await createMember('dana@test.local')).id;
  librarianCookie = await loginAs(app, 'alex@test.local', LIBRARIAN_PASSWORD);
  memberCookie = await loginAs(app, 'sam@test.local', MEMBER_PASSWORD);
  otherMemberCookie = await loginAs(app, 'dana@test.local', MEMBER_PASSWORD);
  itemId = (await seedItem(librarianId, { code: 'RACE-1' })).id;
});

/** Sorted status codes, so a test can assert the pair without caring who won. */
function statuses(responses: request.Response[]): number[] {
  return responses.map((r) => r.status).sort((a, b) => a - b);
}

describe('one open loan per item', () => {
  it('lets exactly one of two simultaneous requests win', async () => {
    const responses = await Promise.all([
      requestLoan(app, memberCookie, itemId),
      requestLoan(app, otherMemberCookie, itemId),
    ]);

    expect(statuses(responses)).toEqual([201, 409]);
    expect(responses.find((r) => r.status === 409)!.body.error.code).toBe('item_unavailable');

    // The database, not the response codes, is the real assertion.
    expect(await prisma.loan.count({ where: { itemId } })).toBe(1);
    expect(await prisma.loanEvent.count()).toBe(1);
  });

  it('lets exactly one of two simultaneous direct issues win', async () => {
    const responses = await Promise.all([
      directIssue(app, librarianCookie, { itemId, borrowerId: memberId, dueOn: dateString(7) }),
      directIssue(app, librarianCookie, { itemId, borrowerId: otherMemberId, dueOn: dateString(7) }),
    ]);

    expect(statuses(responses)).toEqual([201, 409]);
    expect(await prisma.loan.count({ where: { itemId } })).toBe(1);
    // The winner writes two events; the loser must write none.
    expect(await prisma.loanEvent.count()).toBe(2);
  });

  it('holds when a request and a direct issue race for the same item', async () => {
    const responses = await Promise.all([
      requestLoan(app, memberCookie, itemId),
      directIssue(app, librarianCookie, { itemId, borrowerId: otherMemberId, dueOn: dateString(7) }),
    ]);

    expect(statuses(responses)).toEqual([201, 409]);

    const open = await prisma.loan.findMany({
      where: { itemId, status: { in: ['requested', 'issued'] } },
    });
    expect(open).toHaveLength(1);
  });

  it('survives five simultaneous requests for one item', async () => {
    const cookies = [memberCookie, otherMemberCookie, librarianCookie, memberCookie, otherMemberCookie];

    const responses = await Promise.all(cookies.map((c) => requestLoan(app, c, itemId)));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await prisma.loan.count({ where: { itemId } })).toBe(1);
  });
});

describe('one transition per loan', () => {
  it('lets exactly one of two simultaneous issues win, writing one event', async () => {
    const requested = await requestLoan(app, memberCookie, itemId);
    const loanId = requested.body.loan.id;

    const responses = await Promise.all([
      issueLoan(app, librarianCookie, loanId, { dueOn: dateString(7) }),
      issueLoan(app, librarianCookie, loanId, { dueOn: dateString(21) }),
    ]);

    expect(statuses(responses)).toEqual([200, 409]);
    expect(responses.find((r) => r.status === 409)!.body.error.code).toBe('invalid_transition');

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
    expect(loan.status).toBe('issued');

    // The point of doing the state change and the event write in one
    // transaction: the loser rolls back and leaves no second `issued` entry.
    const events = await prisma.loanEvent.findMany({ where: { loanId } });
    expect(events.filter((e) => e.type === 'issued')).toHaveLength(1);
    expect(events).toHaveLength(2);
  });

  it('lets exactly one of two simultaneous returns win, writing one event', async () => {
    const issued = await directIssue(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(7),
    });
    const loanId = issued.body.loan.id;

    const responses = await Promise.all([
      returnLoan(app, librarianCookie, loanId, 'First'),
      returnLoan(app, librarianCookie, loanId, 'Second'),
    ]);

    expect(statuses(responses)).toEqual([200, 409]);

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
    expect(loan.status).toBe('returned');

    const events = await prisma.loanEvent.findMany({ where: { loanId } });
    expect(events.filter((e) => e.type === 'returned')).toHaveLength(1);
  });

  it('lets exactly one of a simultaneous return and mark-lost win', async () => {
    const issued = await directIssue(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(7),
    });
    const loanId = issued.body.loan.id;

    const responses = await Promise.all([
      returnLoan(app, librarianCookie, loanId),
      request(app).post(`/api/loans/${loanId}/lost`).set('Cookie', librarianCookie).send({}),
    ]);

    expect(statuses(responses)).toEqual([200, 409]);

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
    // Whichever won, the loan is in exactly one terminal state and the other
    // timestamp is null — the CHECK constraints would reject anything else.
    expect(['returned', 'lost']).toContain(loan.status);
    expect(loan.returnedAt === null || loan.lostAt === null).toBe(true);

    const events = await prisma.loanEvent.findMany({ where: { loanId } });
    expect(events.filter((e) => e.type === 'returned' || e.type === 'lost')).toHaveLength(1);
  });
});

describe('a loan racing an archive', () => {
  /**
   * The invariant, stated as the thing that must never be true afterwards:
   * an item that is archived must not have an open loan created after the
   * archive committed.
   *
   * Two outcomes are acceptable and both are correct:
   *   A. the loan commits first, then the archive — the open loan stays valid
   *      and the item becomes archived
   *   B. the archive commits first, and the loan attempt is refused 409
   *
   * The failure this guards against is a third outcome: archive commits, and
   * then a loan is written against the now-archived item. A plain
   * `SELECT archived_at` followed by an `INSERT` produces exactly that whenever
   * the archive lands between the two statements.
   */
  async function assertAcceptableOutcome(
    loanResponse: request.Response,
    archiveResponse: request.Response,
  ): Promise<void> {
    const item = await prisma.catalogueItem.findUniqueOrThrow({ where: { id: itemId } });
    const openLoans = await prisma.loan.findMany({
      where: { itemId, status: { in: ['requested', 'issued'] } },
    });

    if (loanResponse.status === 201) {
      // Outcome A: the loan won the lock. The archive may have succeeded after
      // it; either way the existing open loan is untouched and still open.
      expect(openLoans).toHaveLength(1);
      expect(archiveResponse.status).toBe(200);
      expect(item.archivedAt).not.toBeNull();
      return;
    }

    // Outcome B: the archive won. The loan must have been refused for that
    // reason, and no open loan may exist.
    expect(loanResponse.status).toBe(409);
    expect(loanResponse.body.error.code).toBe('item_archived');
    expect(openLoans).toHaveLength(0);
    expect(item.archivedAt).not.toBeNull();
  }

  it('never creates a request against an item the archive already committed', async () => {
    const [loanResponse, archiveResponse] = await Promise.all([
      requestLoan(app, memberCookie, itemId),
      request(app).post(`/api/items/${itemId}/archive`).set('Cookie', librarianCookie),
    ]);

    await assertAcceptableOutcome(loanResponse, archiveResponse);
  });

  it('never creates a direct issue against an item the archive already committed', async () => {
    const [loanResponse, archiveResponse] = await Promise.all([
      directIssue(app, librarianCookie, { itemId, borrowerId: memberId, dueOn: dateString(7) }),
      request(app).post(`/api/items/${itemId}/archive`).set('Cookie', librarianCookie),
    ]);

    await assertAcceptableOutcome(loanResponse, archiveResponse);
  });

  it('holds across repeated attempts, whichever way the race falls', async () => {
    // One run can land the same way every time and hide a broken lock. Running
    // the race repeatedly on fresh items exercises both interleavings.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const item = await seedItem(librarianId, { code: `RACE-LOOP-${attempt}` });

      const [loanResponse] = await Promise.all([
        requestLoan(app, memberCookie, item.id),
        request(app).post(`/api/items/${item.id}/archive`).set('Cookie', librarianCookie),
      ]);

      const stored = await prisma.catalogueItem.findUniqueOrThrow({ where: { id: item.id } });
      const open = await prisma.loan.count({
        where: { itemId: item.id, status: { in: ['requested', 'issued'] } },
      });

      if (stored.archivedAt !== null && loanResponse.status === 201) {
        // Acceptable only if the loan was committed BEFORE the archive, which
        // is outcome A. What must never happen is a 409-free loan appearing
        // after an archive that the loan attempt could see.
        expect(open).toBe(1);
      }
      if (loanResponse.status === 409) {
        expect(loanResponse.body.error.code).toBe('item_archived');
        expect(open).toBe(0);
      }
    }
  });

  it('never issues a requested loan against an item the archive already committed', async () => {
    const requested = await requestLoan(app, memberCookie, itemId);
    const loanId = requested.body.loan.id;

    const [issueResponse] = await Promise.all([
      issueLoan(app, librarianCookie, loanId, { dueOn: dateString(7) }),
      request(app).post(`/api/items/${itemId}/archive`).set('Cookie', librarianCookie),
    ]);

    const item = await prisma.catalogueItem.findUniqueOrThrow({ where: { id: itemId } });
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });

    if (issueResponse.status === 200) {
      // The issue won the lock and committed before the archive.
      expect(loan.status).toBe('issued');
    } else {
      expect(issueResponse.status).toBe(409);
      expect(issueResponse.body.error.code).toBe('item_archived');
      expect(loan.status).toBe('requested');
      expect(item.archivedAt).not.toBeNull();
    }
  });

  it('still allows a return to race an archive, because returns are never blocked', async () => {
    const issued = await directIssue(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(7),
    });
    const loanId = issued.body.loan.id;

    const [returnResponse, archiveResponse] = await Promise.all([
      returnLoan(app, librarianCookie, loanId),
      request(app).post(`/api/items/${itemId}/archive`).set('Cookie', librarianCookie),
    ]);

    // Both must succeed. Archiving stops an item going out; it never stops one
    // coming back, so there is no lock contention to resolve here.
    expect(returnResponse.status).toBe(200);
    expect(archiveResponse.status).toBe(200);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe('returned');
  });
});

/**
 * Deterministic proof that the item row lock is real.
 *
 * The `Promise.all` races above assert the right OUTCOME, but they cannot force
 * the interleaving that matters — the window between reading `archived_at` and
 * writing the loan is microseconds wide, so the scheduler almost never lands
 * inside it. Removing `FOR UPDATE` from the service and re-running them was
 * measured: all twelve still passed. Outcome-only race tests are close to
 * worthless for proving a lock exists.
 *
 * These tests instead control the interleaving explicitly. A second connection
 * opens a transaction, archives the item, and holds the transaction OPEN,
 * keeping the row lock. The API call is then made while that lock is held:
 *
 *   - with `FOR UPDATE`, the request blocks on the lock, and once the archive
 *     commits it re-reads the row, sees the item archived, and refuses
 *   - without it, the request reads the pre-archive row (the uncommitted
 *     archive is invisible under READ COMMITTED) and commits a loan against an
 *     item that is archived a moment later
 *
 * So the assertion "the request had not completed while the lock was held" is
 * what actually distinguishes the two implementations.
 */
describe('the item lock, proven deterministically', () => {
  const HOLD_MS = 400;

  function delay(ms: number): Promise<'timeout'> {
    return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
  }

  /**
   * Archives the item inside a transaction that stays open until released, so
   * the row lock is held for as long as the caller needs.
   */
  function holdArchiveLock(targetId: string): {
    started: Promise<void>;
    release: () => void;
    finished: Promise<void>;
  } {
    let markStarted: () => void;
    let release: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const finished = adminPrisma
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`UPDATE catalogue_items SET archived_at = now() WHERE id = ${targetId}::uuid`;
          markStarted();
          await held;
        },
        { timeout: 20_000, maxWait: 20_000 },
      )
      .then(() => undefined);

    return { started, release: () => release(), finished };
  }

  it('blocks a request while an uncommitted archive holds the row, then refuses it', async () => {
    const lock = holdArchiveLock(itemId);
    await lock.started;

    const pending = requestLoan(app, memberCookie, itemId);

    // The request must NOT have completed: it is waiting on the row lock.
    // Without FOR UPDATE it would have finished here with a 201.
    const raced = await Promise.race([pending.then(() => 'completed' as const), delay(HOLD_MS)]);
    expect(raced, 'the request should be blocked on the item row lock').toBe('timeout');

    lock.release();
    await lock.finished;

    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('item_archived');

    expect(
      await prisma.loan.count({ where: { itemId, status: { in: ['requested', 'issued'] } } }),
    ).toBe(0);
  });

  it('blocks a direct issue the same way', async () => {
    const lock = holdArchiveLock(itemId);
    await lock.started;

    const pending = directIssue(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(7),
    });

    const raced = await Promise.race([pending.then(() => 'completed' as const), delay(HOLD_MS)]);
    expect(raced, 'the direct issue should be blocked on the item row lock').toBe('timeout');

    lock.release();
    await lock.finished;

    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('item_archived');
    expect(await prisma.loan.count({ where: { itemId } })).toBe(0);
  });

  it('blocks issuing an existing requested loan the same way', async () => {
    const requested = await requestLoan(app, memberCookie, itemId);
    const loanId = requested.body.loan.id;

    const lock = holdArchiveLock(itemId);
    await lock.started;

    const pending = issueLoan(app, librarianCookie, loanId, { dueOn: dateString(7) });

    const raced = await Promise.race([pending.then(() => 'completed' as const), delay(HOLD_MS)]);
    expect(raced, 'the issue should be blocked on the item row lock').toBe('timeout');

    lock.release();
    await lock.finished;

    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('item_archived');
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe('requested');
  });

  it('does NOT block a return, because returns are deliberately unlocked', async () => {
    const issued = await directIssue(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(7),
    });
    const loanId = issued.body.loan.id;

    const lock = holdArchiveLock(itemId);
    await lock.started;

    // The counterpart assertion: a return takes no item lock, so it completes
    // while the archive is still uncommitted. Archiving stops an item going
    // out; it must never stop one coming back, not even briefly.
    const response = await returnLoan(app, librarianCookie, loanId);
    expect(response.status).toBe(200);

    lock.release();
    await lock.finished;

    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe('returned');
  });
});
