import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { loginAs, seedItem } from './helpers/items.js';
import {
  dateString,
  directIssue,
  getLoan,
  issueLoan,
  issuedLoan,
  markLost,
  requestLoan,
  returnLoan,
  storedEvents,
} from './helpers/loans.js';
import {
  createLibrarian,
  createMember,
  LIBRARIAN_PASSWORD,
  MEMBER_PASSWORD,
} from './helpers/users.js';

const app = createApp();

let librarianId: string;
let memberId: string;
let otherMemberId: string;
let librarianCookie: string;
let memberCookie: string;
let itemId: string;

beforeEach(async () => {
  librarianId = (await createLibrarian('alex@test.local')).id;
  memberId = (await createMember('sam@test.local')).id;
  otherMemberId = (await createMember('dana@test.local')).id;
  librarianCookie = await loginAs(app, 'alex@test.local', LIBRARIAN_PASSWORD);
  memberCookie = await loginAs(app, 'sam@test.local', MEMBER_PASSWORD);
  itemId = (await seedItem(librarianId, { title: 'Canon EOS R6', code: 'CAM-001' })).id;
});

describe('requesting a loan', () => {
  it('creates a Requested loan with no due date', async () => {
    const response = await requestLoan(app, memberCookie, itemId);

    expect(response.status).toBe(201);
    expect(response.body.loan).toMatchObject({
      itemId,
      borrowerId: memberId,
      status: 'requested',
      dueOn: null,
      issuedAt: null,
      isOverdue: false,
    });
  });

  it('records the borrower from the session, ignoring anything the client sends', async () => {
    // `borrowerId` is not part of this route's schema at all, so a member has
    // nothing to tamper with — the request is rejected outright rather than
    // silently reattributed.
    const spoofed = await request(app)
      .post('/api/loans/request')
      .set('Cookie', memberCookie)
      .send({ itemId, borrowerId: otherMemberId });

    expect(spoofed.status).toBe(400);

    const honest = await requestLoan(app, memberCookie, itemId);
    expect(honest.body.loan.borrowerId).toBe(memberId);
  });

  it('writes a requested event actored by the borrower', async () => {
    const response = await requestLoan(app, memberCookie, itemId);
    const events = await storedEvents(response.body.loan.id);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'requested', actorId: memberId, note: null });
  });

  it('lets a librarian request an item for themselves', async () => {
    const response = await requestLoan(app, librarianCookie, itemId);

    expect(response.status).toBe(201);
    expect(response.body.loan.borrowerId).toBe(librarianId);
  });

  it('refuses a second request while the item has an open loan', async () => {
    await requestLoan(app, memberCookie, itemId);

    const second = await requestLoan(app, librarianCookie, itemId);

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('item_unavailable');
    expect(await prisma.loan.count({ where: { itemId } })).toBe(1);
  });

  it('refuses a request for an item that is already issued', async () => {
    await issuedLoan(app, librarianCookie, { itemId, borrowerId: otherMemberId });

    const response = await requestLoan(app, memberCookie, itemId);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('item_unavailable');
  });

  it('allows a new loan once the previous one is closed', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: otherMemberId });
    await returnLoan(app, librarianCookie, loanId);

    const response = await requestLoan(app, memberCookie, itemId);

    expect(response.status).toBe(201);
    expect(await prisma.loan.count({ where: { itemId } })).toBe(2);
  });

  it('returns 404 for an unknown item', async () => {
    const response = await requestLoan(app, memberCookie, '11111111-1111-4111-8111-111111111111');
    expect(response.status).toBe(404);
  });
});

describe('librarian direct issue', () => {
  it('creates an Issued loan for another borrower', async () => {
    const response = await directIssue(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(14),
    });

    expect(response.status).toBe(201);
    expect(response.body.loan).toMatchObject({
      borrowerId: memberId,
      status: 'issued',
      isOverdue: false,
    });
    expect(response.body.loan.dueOn).not.toBeNull();
  });

  it('writes both a requested and an issued event, at the same instant', async () => {
    const response = await directIssue(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(14),
      note: 'Handed over at the desk.',
    });

    const events = await storedEvents(response.body.loan.id);

    // The same timeline shape as a loan that was requested first, so a reader
    // does not have to know how it reached Issued.
    expect(events.map((e) => e.type)).toEqual(['requested', 'issued']);
    expect(events[0]!.createdAt.getTime()).toBe(events[1]!.createdAt.getTime());
    expect(events[1]!.note).toBe('Handed over at the desk.');
    expect(events.every((e) => e.actorId === librarianId)).toBe(true);
  });

  it('rejects a borrower who does not exist, writing nothing', async () => {
    const response = await directIssue(app, librarianCookie, {
      itemId,
      borrowerId: '11111111-1111-4111-8111-111111111111',
      dueOn: dateString(14),
    });

    expect(response.status).toBe(400);
    expect(await prisma.loan.count()).toBe(0);
    expect(await prisma.loanEvent.count()).toBe(0);
  });

  it('requires a due date', async () => {
    const response = await request(app)
      .post('/api/loans')
      .set('Cookie', librarianCookie)
      .send({ itemId, borrowerId: memberId });

    expect(response.status).toBe(400);
  });

  it('accepts a due date in the past, which is how a loan becomes overdue', async () => {
    const response = await directIssue(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(-3),
    });

    expect(response.status).toBe(201);
    expect(response.body.loan.isOverdue).toBe(true);
  });
});

describe('the happy path', () => {
  it('goes requested -> issued -> returned, with a timeline to match', async () => {
    const requested = await requestLoan(app, memberCookie, itemId);
    const loanId = requested.body.loan.id;

    const issued = await issueLoan(app, librarianCookie, loanId, {
      dueOn: dateString(14),
      note: 'Two batteries included.',
    });
    expect(issued.status).toBe(200);
    expect(issued.body.loan.status).toBe('issued');

    const returned = await returnLoan(app, librarianCookie, loanId, 'Back in good condition.');
    expect(returned.status).toBe(200);
    expect(returned.body.loan.status).toBe('returned');
    expect(returned.body.loan.returnedAt).not.toBeNull();

    const events = await storedEvents(loanId);
    expect(events.map((e) => e.type)).toEqual(['requested', 'issued', 'returned']);
    expect(events.map((e) => e.actorId)).toEqual([memberId, librarianId, librarianId]);
    expect(events.map((e) => e.note)).toEqual([null, 'Two batteries included.', 'Back in good condition.']);
  });

  it('goes requested -> issued -> lost', async () => {
    const requested = await requestLoan(app, memberCookie, itemId);
    const loanId = requested.body.loan.id;
    await issueLoan(app, librarianCookie, loanId, { dueOn: dateString(14) });

    const lost = await markLost(app, librarianCookie, loanId, 'Reported stolen.');

    expect(lost.status).toBe(200);
    expect(lost.body.loan.status).toBe('lost');
    expect(lost.body.loan.lostAt).not.toBeNull();
    expect((await storedEvents(loanId)).map((e) => e.type)).toEqual([
      'requested',
      'issued',
      'lost',
    ]);
  });

  it('allows marking lost before the due date has passed', async () => {
    // The brief is explicit that Lost is available "whether or not it has
    // become overdue".
    const loanId = await issuedLoan(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(30),
    });

    const response = await markLost(app, librarianCookie, loanId);
    expect(response.status).toBe(200);
  });

  it('allows marking lost after it has become overdue', async () => {
    const loanId = await issuedLoan(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(-10),
    });

    const response = await markLost(app, librarianCookie, loanId);
    expect(response.status).toBe(200);
  });

  it('keeps timestamps in chronological order', async () => {
    const requested = await requestLoan(app, memberCookie, itemId);
    const loanId = requested.body.loan.id;
    await issueLoan(app, librarianCookie, loanId, { dueOn: dateString(7) });
    await returnLoan(app, librarianCookie, loanId);

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });

    expect(loan.issuedAt!.getTime()).toBeGreaterThanOrEqual(loan.requestedAt.getTime());
    expect(loan.returnedAt!.getTime()).toBeGreaterThanOrEqual(loan.issuedAt!.getTime());
  });
});

describe('invalid transitions', () => {
  /** Every rejection must be a 409 that names where the loan actually is. */
  async function expectRefused(
    response: request.Response,
    loanId: string,
    expectedEventCount: number,
  ) {
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('invalid_transition');
    expect(response.body.error.message).toMatch(/loan is (requested|issued|returned|lost)/);
    // A refused transition leaves no trace on the timeline.
    expect(await storedEvents(loanId)).toHaveLength(expectedEventCount);
  }

  it('refuses requested -> returned', async () => {
    const { body } = await requestLoan(app, memberCookie, itemId);
    await expectRefused(await returnLoan(app, librarianCookie, body.loan.id), body.loan.id, 1);
  });

  it('refuses requested -> lost', async () => {
    const { body } = await requestLoan(app, memberCookie, itemId);
    await expectRefused(await markLost(app, librarianCookie, body.loan.id), body.loan.id, 1);
  });

  it('refuses issued -> issued', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await expectRefused(
      await issueLoan(app, librarianCookie, loanId, { dueOn: dateString(20) }),
      loanId,
      2,
    );
  });

  it('refuses returned -> issued', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await returnLoan(app, librarianCookie, loanId);
    await expectRefused(
      await issueLoan(app, librarianCookie, loanId, { dueOn: dateString(20) }),
      loanId,
      3,
    );
  });

  it('refuses returned -> returned', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await returnLoan(app, librarianCookie, loanId);
    await expectRefused(await returnLoan(app, librarianCookie, loanId), loanId, 3);
  });

  it('refuses returned -> lost', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await returnLoan(app, librarianCookie, loanId);
    await expectRefused(await markLost(app, librarianCookie, loanId), loanId, 3);
  });

  it('refuses lost -> issued', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await markLost(app, librarianCookie, loanId);
    await expectRefused(
      await issueLoan(app, librarianCookie, loanId, { dueOn: dateString(20) }),
      loanId,
      3,
    );
  });

  it('refuses lost -> returned', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await markLost(app, librarianCookie, loanId);
    await expectRefused(await returnLoan(app, librarianCookie, loanId), loanId, 3);
  });

  it('refuses lost -> lost', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await markLost(app, librarianCookie, loanId);
    await expectRefused(await markLost(app, librarianCookie, loanId), loanId, 3);
  });

  it('returns 404, not 409, for a loan that does not exist', async () => {
    const missing = '11111111-1111-4111-8111-111111111111';
    for (const attempt of [
      issueLoan(app, librarianCookie, missing, { dueOn: dateString(7) }),
      returnLoan(app, librarianCookie, missing),
      markLost(app, librarianCookie, missing),
    ]) {
      expect((await attempt).status).toBe(404);
    }
  });

  it('leaves the loan in its original state after a refusal', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await returnLoan(app, librarianCookie, loanId);

    await markLost(app, librarianCookie, loanId);

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
    expect(loan.status).toBe('returned');
    expect(loan.lostAt).toBeNull();
  });
});

describe('archived items', () => {
  it('refuses a request for an archived item', async () => {
    const archived = await seedItem(librarianId, { archivedAt: new Date() });

    const response = await requestLoan(app, memberCookie, archived.id);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('item_archived');
    expect(await prisma.loan.count()).toBe(0);
  });

  it('refuses a direct issue of an archived item', async () => {
    const archived = await seedItem(librarianId, { archivedAt: new Date() });

    const response = await directIssue(app, librarianCookie, {
      itemId: archived.id,
      borrowerId: memberId,
      dueOn: dateString(14),
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('item_archived');
  });

  it('refuses to issue a loan that was requested before the item was archived', async () => {
    // The deferred milestone 3 case: the request was legitimate when it was
    // made, but the item is out of circulation now, so it must not go out.
    const requested = await requestLoan(app, memberCookie, itemId);
    const loanId = requested.body.loan.id;

    await request(app).post(`/api/items/${itemId}/archive`).set('Cookie', librarianCookie);

    const response = await issueLoan(app, librarianCookie, loanId, { dueOn: dateString(14) });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('item_archived');
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe('requested');
    expect(await storedEvents(loanId)).toHaveLength(1);
  });

  it('still allows returning a loan on an item archived after issue', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await request(app).post(`/api/items/${itemId}/archive`).set('Cookie', librarianCookie);

    const response = await returnLoan(app, librarianCookie, loanId, 'Returned after withdrawal.');

    expect(response.status).toBe(200);
    expect(response.body.loan.status).toBe('returned');
  });

  it('still allows marking lost on an item archived after issue', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await request(app).post(`/api/items/${itemId}/archive`).set('Cookie', librarianCookie);

    const response = await markLost(app, librarianCookie, loanId);

    expect(response.status).toBe(200);
    expect(response.body.loan.status).toBe('lost');
  });

  it('does not modify the loan or its events when the item is archived', async () => {
    const requested = await requestLoan(app, memberCookie, itemId);
    const loanId = requested.body.loan.id;

    const loanBefore = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
    const eventsBefore = await storedEvents(loanId);

    await request(app).post(`/api/items/${itemId}/archive`).set('Cookie', librarianCookie);

    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).toEqual(loanBefore);
    expect(await storedEvents(loanId)).toEqual(eventsBefore);
  });
});

describe('notes', () => {
  it('accepts a loan with no note at all', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });

    const response = await returnLoan(app, librarianCookie, loanId);

    expect(response.status).toBe(200);
    const events = await storedEvents(loanId);
    expect(events.at(-1)!.note).toBeNull();
  });

  it('trims a supplied note', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });

    await returnLoan(app, librarianCookie, loanId, '   Scuffed lens cap.   ');

    expect((await storedEvents(loanId)).at(-1)!.note).toBe('Scuffed lens cap.');
  });

  it('rejects a blank note rather than storing whitespace', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });

    const response = await returnLoan(app, librarianCookie, loanId, '    ');

    expect(response.status).toBe(400);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe('issued');
  });

  it('rejects an over-long note', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });

    const response = await markLost(app, librarianCookie, loanId, 'x'.repeat(1001));

    expect(response.status).toBe(400);
  });

  it('does not require a note to mark a loan lost', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });

    const response = await markLost(app, librarianCookie, loanId);

    expect(response.status).toBe(200);
    expect((await storedEvents(loanId)).at(-1)!.note).toBeNull();
  });
});

describe('overdue is derived, never stored', () => {
  it('is false for a loan due today', async () => {
    const loanId = await issuedLoan(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(0),
    });

    const response = await getLoan(app, librarianCookie, loanId);
    expect(response.body.loan.isOverdue).toBe(false);
  });

  it('is true for a loan due yesterday', async () => {
    const loanId = await issuedLoan(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(-1),
    });

    const response = await getLoan(app, librarianCookie, loanId);
    expect(response.body.loan.isOverdue).toBe(true);
  });

  it('is false for a returned loan whose due date has passed', async () => {
    const loanId = await issuedLoan(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(-30),
    });
    await returnLoan(app, librarianCookie, loanId);

    const response = await getLoan(app, librarianCookie, loanId);
    expect(response.body.loan.status).toBe('returned');
    expect(response.body.loan.isOverdue).toBe(false);
  });

  it('is false for a lost loan whose due date has passed', async () => {
    const loanId = await issuedLoan(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(-30),
    });
    await markLost(app, librarianCookie, loanId);

    const response = await getLoan(app, librarianCookie, loanId);
    expect(response.body.loan.isOverdue).toBe(false);
  });

  it('never writes overdue to the status column', async () => {
    await issuedLoan(app, librarianCookie, {
      itemId,
      borrowerId: memberId,
      dueOn: dateString(-90),
    });

    const statuses = await prisma.$queryRawUnsafe<{ status: string }[]>(
      `SELECT DISTINCT status::text AS status FROM loans`,
    );
    expect(statuses.map((s) => s.status)).not.toContain('overdue');
  });
});

describe('reading a loan', () => {
  it('returns the loan with its timeline, newest event last', async () => {
    const requested = await requestLoan(app, memberCookie, itemId);
    const loanId = requested.body.loan.id;
    await issueLoan(app, librarianCookie, loanId, { dueOn: dateString(7) });

    const response = await getLoan(app, librarianCookie, loanId);

    expect(response.status).toBe(200);
    expect(response.body.events.map((e: { type: string }) => e.type)).toEqual([
      'requested',
      'issued',
    ]);
    expect(response.body.events[1].actor).toMatchObject({ id: librarianId, name: 'Test Librarian' });
  });

  it('lets a member read their own loan', async () => {
    const { body } = await requestLoan(app, memberCookie, itemId);

    const response = await getLoan(app, memberCookie, body.loan.id);
    expect(response.status).toBe(200);
  });

  it("refuses a member another member's loan", async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: otherMemberId });

    const response = await getLoan(app, memberCookie, loanId);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('lets a librarian read any loan', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: otherMemberId });

    expect((await getLoan(app, librarianCookie, loanId)).status).toBe(200);
  });

  it('returns 404 for an unknown loan', async () => {
    const response = await getLoan(app, librarianCookie, '11111111-1111-4111-8111-111111111111');
    expect(response.status).toBe(404);
  });
});

describe('lifecycle authorization', () => {
  it('rejects every lifecycle route when unauthenticated', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });

    const attempts = [
      request(app).post('/api/loans/request').send({ itemId }),
      request(app).post('/api/loans').send({ itemId, borrowerId: memberId, dueOn: dateString(7) }),
      request(app).post(`/api/loans/${loanId}/issue`).send({ dueOn: dateString(7) }),
      request(app).post(`/api/loans/${loanId}/return`).send({}),
      request(app).post(`/api/loans/${loanId}/lost`).send({}),
      request(app).get(`/api/loans/${loanId}`),
    ];

    for (const attempt of attempts) {
      expect((await attempt).status).toBe(401);
    }
  });

  it('refuses a member every librarian-only lifecycle action', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    const other = await seedItem(librarianId, { code: 'OTHER-1' });

    const attempts = [
      directIssue(app, memberCookie, {
        itemId: other.id,
        borrowerId: memberId,
        dueOn: dateString(7),
      }),
      issueLoan(app, memberCookie, loanId, { dueOn: dateString(7) }),
      returnLoan(app, memberCookie, loanId),
      markLost(app, memberCookie, loanId),
    ];

    for (const attempt of attempts) {
      const response = await attempt;
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    }

    // Even though the member is the borrower, they cannot return their own loan.
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe('issued');
  });
});

describe('the item detail loan history', () => {
  it('shows every loan ever made against the item, to a librarian', async () => {
    const first = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await returnLoan(app, librarianCookie, first);
    const second = await issuedLoan(app, librarianCookie, { itemId, borrowerId: otherMemberId });

    const response = await request(app).get(`/api/items/${itemId}`).set('Cookie', librarianCookie);

    expect(response.status).toBe(200);
    expect(response.body.loans).toHaveLength(2);
    expect(response.body.loans.map((l: { id: string }) => l.id)).toContain(first);
    expect(response.body.loans.map((l: { id: string }) => l.id)).toContain(second);
  });

  it('survives archiving the item', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await returnLoan(app, librarianCookie, loanId);
    await request(app).post(`/api/items/${itemId}/archive`).set('Cookie', librarianCookie);

    const response = await request(app).get(`/api/items/${itemId}`).set('Cookie', librarianCookie);

    expect(response.body.item.isArchived).toBe(true);
    expect(response.body.loans).toHaveLength(1);
  });

  it('is not shown to a member', async () => {
    await issuedLoan(app, librarianCookie, { itemId, borrowerId: otherMemberId });

    const response = await request(app).get(`/api/items/${itemId}`).set('Cookie', memberCookie);

    expect(response.status).toBe(200);
    // Showing this would reveal who else has borrowed the item.
    expect(response.body.loans).toBeUndefined();
  });
});

describe('the timeline stays append-only through the service', () => {
  it('refuses an UPDATE or DELETE on events the lifecycle wrote', async () => {
    const loanId = await issuedLoan(app, librarianCookie, { itemId, borrowerId: memberId });
    await returnLoan(app, librarianCookie, loanId, 'Original note.');

    await expect(
      prisma.$executeRawUnsafe(`UPDATE loan_events SET note = 'rewritten'`),
    ).rejects.toThrow(/permission denied|append-only/i);

    await expect(prisma.$executeRawUnsafe(`DELETE FROM loan_events`)).rejects.toThrow(
      /permission denied|append-only/i,
    );

    expect((await storedEvents(loanId)).at(-1)!.note).toBe('Original note.');
  });
});

describe('the assumption the timeline ordering rests on', () => {
  /**
   * Timeline order is `(created_at, type, id)`, and `type` is only a correct
   * tiebreak because a loan can never hold two events of the same type. That is
   * a property of the transition guards rather than of the schema, so it is
   * asserted here rather than assumed.
   *
   * If this ever fails, the enum-order tiebreak is no longer sufficient and the
   * fix is a monotonic sequence column — see docs/decisions.md, Decision 12.
   */
  it('never records the same event type twice for one loan, across a full lifecycle', async () => {
    // Drive every path that writes an event, including the rejected ones.
    const requested = await requestLoan(app, memberCookie, itemId);
    const requestedId = requested.body.loan.id;
    await issueLoan(app, librarianCookie, requestedId, { dueOn: dateString(7) });
    await issueLoan(app, librarianCookie, requestedId, { dueOn: dateString(9) }); // refused
    await returnLoan(app, librarianCookie, requestedId);
    await returnLoan(app, librarianCookie, requestedId); // refused
    await markLost(app, librarianCookie, requestedId); // refused

    const second = await seedItem(librarianId, { code: 'SECOND-1' });
    const directId = await issuedLoan(app, librarianCookie, {
      itemId: second.id,
      borrowerId: memberId,
    });
    await markLost(app, librarianCookie, directId);
    await markLost(app, librarianCookie, directId); // refused

    const duplicates = await prisma.$queryRawUnsafe<{ loan_id: string; type: string; n: bigint }[]>(
      `SELECT loan_id, type::text AS type, count(*) AS n
         FROM loan_events
        GROUP BY loan_id, type
       HAVING count(*) > 1`,
    );

    expect(duplicates).toEqual([]);
  });

  it('orders same-instant events by lifecycle, not by insertion luck', async () => {
    // A direct issue is the only case that writes two events at one instant.
    // Repeated because the failure mode was random uuid ordering: a single run
    // came out right about half the time.
    for (let i = 0; i < 6; i += 1) {
      const item = await seedItem(librarianId, { code: `ORDER-${i}` });
      const loanId = await issuedLoan(app, librarianCookie, {
        itemId: item.id,
        borrowerId: memberId,
      });

      const response = await getLoan(app, librarianCookie, loanId);
      expect(response.body.events.map((e: { type: string }) => e.type)).toEqual([
        'requested',
        'issued',
      ]);
    }
  });

  it('declares loan_event_type in lifecycle order, which is what makes the tiebreak correct', async () => {
    const rows = await prisma.$queryRawUnsafe<{ label: string }[]>(
      `SELECT e.enumlabel AS label
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'loan_event_type'
        ORDER BY e.enumsortorder`,
    );

    // Postgres sorts enum columns by declaration order, so this ordering IS the
    // ordering the timeline query relies on.
    expect(rows.map((r) => r.label)).toEqual(['requested', 'issued', 'returned', 'lost']);
  });
});

