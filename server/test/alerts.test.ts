import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { loginAs, seedItem } from './helpers/items.js';
import { dateString, directIssue, issueLoan, markLost, requestLoan, returnLoan } from './helpers/loans.js';
import {
  createLibrarian,
  createMember,
  LIBRARIAN_PASSWORD,
  MEMBER_PASSWORD,
} from './helpers/users.js';

/**
 * Overdue alerts — goal 10.
 *
 * The rule the whole design turns on is the last sentence of the goal: "If the
 * item is later issued again and becomes overdue on the new loan, the alert
 * returns." Everything here is arranged so that falls out of keying dismissal
 * on the loan rather than the item.
 */

const app = createApp();

type Alert = {
  loanId: string;
  daysOverdue: number;
  item: { code: string; isArchived: boolean };
  borrower: { name: string };
};

let alexId: string;
let alexCookie: string;
let priyaCookie: string;
let memberId: string;
let memberCookie: string;

beforeEach(async () => {
  alexId = (await createLibrarian('alex@test.local')).id;
  await createLibrarian('priya@test.local');
  memberId = (await createMember('sam@test.local')).id;
  alexCookie = await loginAs(app, 'alex@test.local', LIBRARIAN_PASSWORD);
  priyaCookie = await loginAs(app, 'priya@test.local', LIBRARIAN_PASSWORD);
  memberCookie = await loginAs(app, 'sam@test.local', MEMBER_PASSWORD);
});

function alerts(cookie: string, query = '') {
  return request(app).get(`/api/alerts${query}`).set('Cookie', cookie);
}

function dismiss(cookie: string, loanId: string) {
  return request(app).post(`/api/alerts/${loanId}/dismiss`).set('Cookie', cookie);
}

/** An issued loan on a fresh item, due `dueInDays` from today. */
async function issuedLoan(code: string, dueInDays: number): Promise<string> {
  const item = await seedItem(alexId, { code });
  const response = await directIssue(app, alexCookie, {
    itemId: item.id,
    borrowerId: memberId,
    dueOn: dateString(dueInDays),
  });
  expect(response.status).toBe(201);
  return response.body.loan.id as string;
}

describe('authorization', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const loanId = await issuedLoan('AUTH-1', -1);

    expect((await request(app).get('/api/alerts')).status).toBe(401);
    expect((await request(app).post(`/api/alerts/${loanId}/dismiss`)).status).toBe(401);
  });

  it('rejects a member with 403 on both routes', async () => {
    const loanId = await issuedLoan('AUTH-2', -1);

    expect((await alerts(memberCookie)).status).toBe(403);
    expect((await dismiss(memberCookie, loanId)).status).toBe(403);
    expect(await prisma.alertDismissal.count()).toBe(0);
  });
});

describe('what raises an alert', () => {
  it('lists an issued loan past its due date', async () => {
    await issuedLoan('LATE-1', -4);

    const response = await alerts(alexCookie);

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
    expect(response.body.rows).toHaveLength(1);
    expect(response.body.rows[0]).toMatchObject({
      daysOverdue: 4,
      item: { code: 'LATE-1' },
      borrower: { name: 'Test Member' },
    });
  });

  it('does not alert on a loan due today', async () => {
    await issuedLoan('TODAY-1', 0);

    expect((await alerts(alexCookie)).body.count).toBe(0);
  });

  it('alerts on a loan due yesterday', async () => {
    await issuedLoan('YESTERDAY-1', -1);

    expect((await alerts(alexCookie)).body.count).toBe(1);
  });

  it('does not alert on a requested loan, however old', async () => {
    const item = await seedItem(alexId, { code: 'REQ-1' });
    await requestLoan(app, memberCookie, item.id);

    expect((await alerts(alexCookie)).body.count).toBe(0);
  });

  it('drops a loan from alerts once it is returned', async () => {
    const loanId = await issuedLoan('BACK-1', -10);
    expect((await alerts(alexCookie)).body.count).toBe(1);

    await returnLoan(app, alexCookie, loanId);

    expect((await alerts(alexCookie)).body.count).toBe(0);
  });

  it('drops a loan from alerts once it is marked lost', async () => {
    const loanId = await issuedLoan('GONE-1', -10);
    await markLost(app, alexCookie, loanId);

    expect((await alerts(alexCookie)).body.count).toBe(0);
  });

  it('orders the most overdue first', async () => {
    await issuedLoan('OLD-1', -30);
    await issuedLoan('MID-1', -10);
    await issuedLoan('NEW-1', -2);

    const rows: Alert[] = (await alerts(alexCookie)).body.rows;

    expect(rows.map((row) => row.item.code)).toEqual(['OLD-1', 'MID-1', 'NEW-1']);
  });

  it('still alerts on an archived item that is out and overdue', async () => {
    const item = await seedItem(alexId, { code: 'ARCH-1' });
    await directIssue(app, alexCookie, {
      itemId: item.id,
      borrowerId: memberId,
      dueOn: dateString(-6),
    });
    await request(app).post(`/api/items/${item.id}/archive`).set('Cookie', alexCookie);

    const rows: Alert[] = (await alerts(alexCookie)).body.rows;

    // Archiving withdraws an item from circulation; it does not bring it back.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.item.isArchived).toBe(true);
  });
});

describe('dismissal', () => {
  it('removes the alert and decrements the badge count', async () => {
    const loanId = await issuedLoan('DIS-1', -3);
    await issuedLoan('DIS-2', -3);
    expect((await alerts(alexCookie)).body.count).toBe(2);

    const response = await dismiss(alexCookie, loanId);
    expect(response.status).toBe(204);

    const after = await alerts(alexCookie);
    expect(after.body.count).toBe(1);
    expect(after.body.rows.map((r: Alert) => r.loanId)).not.toContain(loanId);
  });

  it('stays dismissed across requests', async () => {
    const loanId = await issuedLoan('DIS-3', -3);
    await dismiss(alexCookie, loanId);

    for (let i = 0; i < 3; i += 1) {
      expect((await alerts(alexCookie)).body.count).toBe(0);
    }
  });

  it('is idempotent', async () => {
    const loanId = await issuedLoan('DIS-4', -3);

    expect((await dismiss(alexCookie, loanId)).status).toBe(204);
    expect((await dismiss(alexCookie, loanId)).status).toBe(204);

    expect(await prisma.alertDismissal.count({ where: { loanId } })).toBe(1);
  });

  it('does not hide the alert from another librarian', async () => {
    const loanId = await issuedLoan('DIS-5', -3);

    await dismiss(alexCookie, loanId);

    // One librarian acknowledging an overdue item must not silence it for the
    // whole team — the badge belongs to its viewer.
    expect((await alerts(alexCookie)).body.count).toBe(0);
    expect((await alerts(priyaCookie)).body.count).toBe(1);
  });

  it('refuses to dismiss a loan that is not overdue', async () => {
    const loanId = await issuedLoan('EARLY-1', 14);

    const response = await dismiss(alexCookie, loanId);

    // Otherwise the row would sit there and mute the alert when the loan later
    // became overdue.
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('not_overdue');
    expect(await prisma.alertDismissal.count()).toBe(0);
  });

  it('refuses to dismiss a returned loan', async () => {
    const loanId = await issuedLoan('DONE-1', -5);
    await returnLoan(app, alexCookie, loanId);

    const response = await dismiss(alexCookie, loanId);

    expect(response.status).toBe(409);
    expect(await prisma.alertDismissal.count()).toBe(0);
  });

  it('returns 404 for an unknown or malformed loan id', async () => {
    expect((await dismiss(alexCookie, '11111111-1111-4111-8111-111111111111')).status).toBe(404);
    expect((await dismiss(alexCookie, 'not-a-uuid')).status).toBe(404);
  });
});

describe('the alert returns on a later loan', () => {
  it('reappears when the item is issued again and goes overdue', async () => {
    // The requirement this whole design exists for.
    const item = await seedItem(alexId, { code: 'AGAIN-1' });

    const first = await directIssue(app, alexCookie, {
      itemId: item.id,
      borrowerId: memberId,
      dueOn: dateString(-5),
    });
    const firstLoanId = first.body.loan.id;

    await dismiss(alexCookie, firstLoanId);
    expect((await alerts(alexCookie)).body.count).toBe(0);

    await returnLoan(app, alexCookie, firstLoanId);

    // The same item goes out again and falls overdue on the NEW loan.
    const second = await directIssue(app, alexCookie, {
      itemId: item.id,
      borrowerId: memberId,
      dueOn: dateString(-2),
    });
    const secondLoanId = second.body.loan.id;

    const response = await alerts(alexCookie);

    expect(response.body.count).toBe(1);
    expect(response.body.rows[0].loanId).toBe(secondLoanId);
    expect(response.body.rows[0].loanId).not.toBe(firstLoanId);

    // The earlier dismissal is still on record — it just cannot apply to a
    // different loan. Keying it on the item would have suppressed this alert.
    expect(await prisma.alertDismissal.count({ where: { loanId: firstLoanId } })).toBe(1);
    expect(await prisma.alertDismissal.count({ where: { loanId: secondLoanId } })).toBe(0);
  });

  it('reappears after a request-then-issue cycle too', async () => {
    const item = await seedItem(alexId, { code: 'AGAIN-2' });
    const first = await directIssue(app, alexCookie, {
      itemId: item.id,
      borrowerId: memberId,
      dueOn: dateString(-5),
    });
    await dismiss(alexCookie, first.body.loan.id);
    await returnLoan(app, alexCookie, first.body.loan.id);

    const requested = await requestLoan(app, memberCookie, item.id);
    await issueLoan(app, alexCookie, requested.body.loan.id, { dueOn: dateString(-1) });

    expect((await alerts(alexCookie)).body.count).toBe(1);
  });
});

describe('the badge count and the rows agree', () => {
  it('reports the full count even when a page is smaller', async () => {
    for (let i = 0; i < 5; i += 1) {
      await issuedLoan(`PAGE-${i}`, -(i + 1));
    }

    const response = await alerts(alexCookie, '?pageSize=2');

    expect(response.body.rows).toHaveLength(2);
    expect(response.body.count).toBe(5);
    expect(response.body.total).toBe(5);
  });

  it('excludes dismissed loans from both the count and the rows', async () => {
    const a = await issuedLoan('BOTH-1', -3);
    await issuedLoan('BOTH-2', -3);
    await dismiss(alexCookie, a);

    const response = await alerts(alexCookie, '?pageSize=100');

    expect(response.body.count).toBe(1);
    expect(response.body.rows).toHaveLength(1);
    expect(response.body.rows[0].loanId).not.toBe(a);
  });

  it('rejects nonsensical pagination', async () => {
    for (const query of ['?page=0', '?pageSize=0', '?page=abc']) {
      expect((await alerts(alexCookie, query)).status, query).toBe(400);
    }
  });
});
