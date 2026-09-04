import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { loginAs, seedItem, seedLoan } from './helpers/items.js';
import {
  createLibrarian,
  createMember,
  LIBRARIAN_PASSWORD,
  MEMBER_PASSWORD,
} from './helpers/users.js';

const app = createApp();

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

describe('catalogue authorization', () => {
  it('rejects every catalogue route when unauthenticated', async () => {
    const item = await seedItem(librarianId);

    const attempts = [
      request(app).get('/api/items'),
      request(app).get(`/api/items/${item.id}`),
      request(app).get('/api/items/mine'),
      request(app).post('/api/items').send({ title: 'x', category: 'y', code: 'Z-1' }),
      request(app).patch(`/api/items/${item.id}`).send({ title: 'x' }),
      request(app).post(`/api/items/${item.id}/archive`),
      request(app).post(`/api/items/${item.id}/restore`),
      request(app).put(`/api/items/${item.id}/custodians`).send({ librarianIds: [] }),
    ];

    for (const attempt of attempts) {
      const response = await attempt;
      expect(response.status).toBe(401);
    }
  });

  it('lets a member read the catalogue', async () => {
    await seedItem(librarianId, { title: 'Readable item' });

    const list = await request(app).get('/api/items').set('Cookie', memberCookie);
    expect(list.status).toBe(200);
    expect(list.body.rows).toHaveLength(1);
  });

  it('refuses a member every catalogue mutation with 403', async () => {
    const item = await seedItem(librarianId);

    const attempts = [
      request(app).post('/api/items').set('Cookie', memberCookie).send({ title: 'x', category: 'y', code: 'Z-1' }),
      request(app).patch(`/api/items/${item.id}`).set('Cookie', memberCookie).send({ title: 'x' }),
      request(app).post(`/api/items/${item.id}/archive`).set('Cookie', memberCookie),
      request(app).post(`/api/items/${item.id}/restore`).set('Cookie', memberCookie),
      request(app).put(`/api/items/${item.id}/custodians`).set('Cookie', memberCookie).send({ librarianIds: [] }),
      request(app).get('/api/items/mine').set('Cookie', memberCookie),
    ];

    for (const attempt of attempts) {
      const response = await attempt;
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    }

    // Nothing was written by any of those attempts.
    expect(await prisma.catalogueItem.count()).toBe(1);
  });

  it('does not expose custodians to a member', async () => {
    const item = await seedItem(librarianId);
    await prisma.itemCustodian.create({ data: { itemId: item.id, librarianId } });

    const asMember = await request(app).get(`/api/items/${item.id}`).set('Cookie', memberCookie);
    const asLibrarian = await request(app).get(`/api/items/${item.id}`).set('Cookie', librarianCookie);

    expect(asMember.status).toBe(200);
    expect(asMember.body.custodians).toBeUndefined();
    expect(asLibrarian.body.custodians).toHaveLength(1);
  });
});

describe('creating and editing items', () => {
  it('creates an item and normalises its code', async () => {
    const response = await request(app)
      .post('/api/items')
      .set('Cookie', librarianCookie)
      .send({ title: '  Canon EOS R6  ', category: 'Cameras', code: 'cam-001' });

    expect(response.status).toBe(201);
    expect(response.body.item).toMatchObject({
      title: 'Canon EOS R6',
      category: 'Cameras',
      code: 'CAM-001',
      isArchived: false,
      archivedAt: null,
    });
  });

  it('records who created the item, from the session rather than the body', async () => {
    const response = await request(app)
      .post('/api/items')
      .set('Cookie', librarianCookie)
      .send({ title: 'Item', category: 'Cat', code: 'C-1' });

    const stored = await prisma.catalogueItem.findUniqueOrThrow({
      where: { id: response.body.item.id },
    });
    expect(stored.createdById).toBe(librarianId);
  });

  it('rejects blank, missing, oversized and unknown fields', async () => {
    const bad: Record<string, unknown>[] = [
      { title: '   ', category: 'Cat', code: 'C-1' },
      { title: 'Item', category: '', code: 'C-1' },
      { title: 'Item', category: 'Cat', code: '   ' },
      { category: 'Cat', code: 'C-1' },
      { title: 'x'.repeat(201), category: 'Cat', code: 'C-1' },
      { title: 'Item', category: 'Cat', code: 'C-1', archivedAt: new Date().toISOString() },
    ];

    for (const body of bad) {
      const response = await request(app).post('/api/items').set('Cookie', librarianCookie).send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error.code).toBe('bad_request');
      expect(Array.isArray(response.body.error.details)).toBe(true);
    }

    expect(await prisma.catalogueItem.count()).toBe(0);
  });

  it('rejects a duplicate code with 409, regardless of case', async () => {
    await request(app)
      .post('/api/items')
      .set('Cookie', librarianCookie)
      .send({ title: 'First', category: 'Cat', code: 'DUP-1' });

    const response = await request(app)
      .post('/api/items')
      .set('Cookie', librarianCookie)
      .send({ title: 'Second', category: 'Cat', code: 'dup-1' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('duplicate_code');
    expect(response.body.error.message).toContain('DUP-1');
  });

  it('applies a partial update and leaves other fields alone', async () => {
    const item = await seedItem(librarianId, { title: 'Before', category: 'Cameras', code: 'P-1' });

    const response = await request(app)
      .patch(`/api/items/${item.id}`)
      .set('Cookie', librarianCookie)
      .send({ title: 'After' });

    expect(response.status).toBe(200);
    expect(response.body.item).toMatchObject({ title: 'After', category: 'Cameras', code: 'P-1' });
  });

  it('rejects an empty update body', async () => {
    const item = await seedItem(librarianId);
    const response = await request(app)
      .patch(`/api/items/${item.id}`)
      .set('Cookie', librarianCookie)
      .send({});

    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown or malformed id', async () => {
    for (const id of ['11111111-1111-4111-8111-111111111111', 'not-a-uuid']) {
      const response = await request(app).get(`/api/items/${id}`).set('Cookie', librarianCookie);
      expect(response.status).toBe(404);
    }
  });
});

describe('archive and restore', () => {
  it('removes an archived item from the default list and reaches it with a filter', async () => {
    const item = await seedItem(librarianId, { title: 'To archive' });
    await seedItem(librarianId, { title: 'Stays active' });

    const archived = await request(app)
      .post(`/api/items/${item.id}/archive`)
      .set('Cookie', librarianCookie);
    expect(archived.status).toBe(200);
    expect(archived.body.item.isArchived).toBe(true);
    expect(archived.body.item.archivedAt).not.toBeNull();

    const defaultList = await request(app).get('/api/items').set('Cookie', librarianCookie);
    expect(defaultList.body.rows.map((r: { title: string }) => r.title)).toEqual(['Stays active']);
    expect(defaultList.body.total).toBe(1);

    const archivedOnly = await request(app)
      .get('/api/items?archived=true')
      .set('Cookie', librarianCookie);
    expect(archivedOnly.body.rows.map((r: { title: string }) => r.title)).toEqual(['To archive']);

    const all = await request(app).get('/api/items?archived=all').set('Cookie', librarianCookie);
    expect(all.body.total).toBe(2);
  });

  it('restores an archived item', async () => {
    const item = await seedItem(librarianId, { archivedAt: new Date() });

    const response = await request(app)
      .post(`/api/items/${item.id}/restore`)
      .set('Cookie', librarianCookie);

    expect(response.status).toBe(200);
    expect(response.body.item.isArchived).toBe(false);
    expect(response.body.item.archivedAt).toBeNull();
  });

  it('rejects archiving an already-archived item with an explanatory 409', async () => {
    const item = await seedItem(librarianId, { title: 'Already gone', archivedAt: new Date() });

    const response = await request(app)
      .post(`/api/items/${item.id}/archive`)
      .set('Cookie', librarianCookie);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('already_archived');
    expect(response.body.error.message).toContain('Already gone');
  });

  it('rejects restoring an item that is not archived', async () => {
    const item = await seedItem(librarianId);

    const response = await request(app)
      .post(`/api/items/${item.id}/restore`)
      .set('Cookie', librarianCookie);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('not_archived');
  });

  it('lets exactly one of two concurrent archives succeed', async () => {
    const item = await seedItem(librarianId);

    // A read-then-write implementation lets both through: each reads "active"
    // before either writes. The conditional UPDATE is what makes this safe.
    const [first, second] = await Promise.all([
      request(app).post(`/api/items/${item.id}/archive`).set('Cookie', librarianCookie),
      request(app).post(`/api/items/${item.id}/archive`).set('Cookie', librarianCookie),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('returns 404 when archiving an item that does not exist', async () => {
    const response = await request(app)
      .post('/api/items/11111111-1111-4111-8111-111111111111/archive')
      .set('Cookie', librarianCookie);

    expect(response.status).toBe(404);
  });
});

describe('archiving does not disturb anything else', () => {
  it('leaves existing loans exactly as they were', async () => {
    const item = await seedItem(librarianId);
    const issued = await seedLoan({
      itemId: item.id,
      borrowerId: memberId,
      status: 'issued',
      librarianId,
    });

    const before = await prisma.loan.findUniqueOrThrow({ where: { id: issued.id } });

    const response = await request(app)
      .post(`/api/items/${item.id}/archive`)
      .set('Cookie', librarianCookie);
    expect(response.status).toBe(200);

    const after = await prisma.loan.findUniqueOrThrow({ where: { id: issued.id } });

    // Archiving must not cancel, close or otherwise touch an open loan. The
    // borrower still has the item and still has to bring it back.
    expect(after).toEqual(before);
    expect(after.status).toBe('issued');
  });

  it('leaves a requested loan open and untouched', async () => {
    const item = await seedItem(librarianId);
    const requested = await seedLoan({ itemId: item.id, borrowerId: memberId, status: 'requested' });

    await request(app).post(`/api/items/${item.id}/archive`).set('Cookie', librarianCookie);

    const after = await prisma.loan.findUniqueOrThrow({ where: { id: requested.id } });
    expect(after.status).toBe('requested');
    expect(await prisma.loan.count()).toBe(1);
  });

  it('keeps custodian links across archive and restore', async () => {
    const item = await seedItem(librarianId);
    await prisma.itemCustodian.create({ data: { itemId: item.id, librarianId } });

    await request(app).post(`/api/items/${item.id}/archive`).set('Cookie', librarianCookie);
    expect(await prisma.itemCustodian.count({ where: { itemId: item.id } })).toBe(1);

    await request(app).post(`/api/items/${item.id}/restore`).set('Cookie', librarianCookie);
    expect(await prisma.itemCustodian.count({ where: { itemId: item.id } })).toBe(1);
  });

  it('keeps the item and its history reachable while archived', async () => {
    const item = await seedItem(librarianId);
    await seedLoan({ itemId: item.id, borrowerId: memberId, status: 'returned', librarianId });
    await request(app).post(`/api/items/${item.id}/archive`).set('Cookie', librarianCookie);

    const detail = await request(app).get(`/api/items/${item.id}`).set('Cookie', librarianCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.item.isArchived).toBe(true);
    // Loan history survives archiving. The item detail endpoint gains the loan
    // list itself in milestone 6.
    expect(await prisma.loan.count({ where: { itemId: item.id } })).toBe(1);
  });

  /**
   * The rule this milestone could only prepare for — "an archived item cannot
   * receive a new loan" — is now enforced by the loan service and tested where
   * it lives: see `loans-lifecycle.test.ts` ("archived items") for the
   * request/issue rejections and the return/lost exceptions, and
   * `loans-concurrency.test.ts` ("a loan racing an archive") for the case where
   * the two operations overlap.
   */
});

describe('server-side search, filtering, sorting and pagination', () => {
  beforeEach(async () => {
    await seedItem(librarianId, { title: 'Canon EOS R6', category: 'Cameras', code: 'CAM-001' });
    await seedItem(librarianId, { title: 'Sony A7 III', category: 'Cameras', code: 'CAM-002' });
    await seedItem(librarianId, { title: 'DeWalt drill', category: 'Tools', code: 'TOOL-001' });
    await seedItem(librarianId, { title: 'Makita saw', category: 'Tools', code: 'TOOL-002' });
    await seedItem(librarianId, { title: 'Archived thing', category: 'Tools', code: 'TOOL-003', archivedAt: new Date() });
  });

  it('searches the title, case-insensitively', async () => {
    const response = await request(app).get('/api/items?search=canon').set('Cookie', librarianCookie);

    expect(response.status).toBe(200);
    expect(response.body.rows.map((r: { code: string }) => r.code)).toEqual(['CAM-001']);
  });

  it('searches the identifying code too', async () => {
    const response = await request(app).get('/api/items?search=tool-00').set('Cookie', librarianCookie);

    // TOOL-003 is archived, so the default filter excludes it.
    expect(response.body.rows.map((r: { code: string }) => r.code)).toEqual(['TOOL-001', 'TOOL-002']);
    expect(response.body.total).toBe(2);
  });

  it('filters by category', async () => {
    const response = await request(app).get('/api/items?category=Tools').set('Cookie', librarianCookie);

    expect(response.body.total).toBe(2);
    expect(response.body.rows.every((r: { category: string }) => r.category === 'Tools')).toBe(true);
  });

  it('combines search with the archived filter', async () => {
    const response = await request(app)
      .get('/api/items?search=archived&archived=true')
      .set('Cookie', librarianCookie);

    expect(response.body.rows.map((r: { code: string }) => r.code)).toEqual(['TOOL-003']);
  });

  it('sorts by each whitelisted field in both directions', async () => {
    const asc = await request(app).get('/api/items?sort=code&dir=asc').set('Cookie', librarianCookie);
    const desc = await request(app).get('/api/items?sort=code&dir=desc').set('Cookie', librarianCookie);

    const ascCodes = asc.body.rows.map((r: { code: string }) => r.code);
    const descCodes = desc.body.rows.map((r: { code: string }) => r.code);

    expect(ascCodes).toEqual(['CAM-001', 'CAM-002', 'TOOL-001', 'TOOL-002']);
    expect(descCodes).toEqual([...ascCodes].reverse());
  });

  it('rejects an unknown sort key rather than interpolating it', async () => {
    for (const sort of ['password_hash', '1; DROP TABLE users', 'nonexistent']) {
      const response = await request(app)
        .get(`/api/items?sort=${encodeURIComponent(sort)}`)
        .set('Cookie', librarianCookie);
      expect(response.status).toBe(400);
    }
  });

  it('reports the total number of matches, not the size of the page', async () => {
    const response = await request(app)
      .get('/api/items?pageSize=2&page=1')
      .set('Cookie', librarianCookie);

    expect(response.body.rows).toHaveLength(2);
    expect(response.body.total).toBe(4);
    expect(response.body.page).toBe(1);
    expect(response.body.pageSize).toBe(2);
  });

  it('returns different rows on the second page and an empty page past the end', async () => {
    const first = await request(app).get('/api/items?pageSize=2&page=1').set('Cookie', librarianCookie);
    const second = await request(app).get('/api/items?pageSize=2&page=2').set('Cookie', librarianCookie);
    const past = await request(app).get('/api/items?pageSize=2&page=99').set('Cookie', librarianCookie);

    const firstIds = first.body.rows.map((r: { id: string }) => r.id);
    const secondIds = second.body.rows.map((r: { id: string }) => r.id);

    expect(firstIds).not.toEqual(secondIds);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
    expect(past.body.rows).toEqual([]);
    expect(past.body.total).toBe(4);
  });

  it('caps an oversized pageSize instead of honouring it', async () => {
    const response = await request(app)
      .get('/api/items?pageSize=100000')
      .set('Cookie', librarianCookie);

    expect(response.status).toBe(200);
    expect(response.body.pageSize).toBe(100);
  });

  it('rejects a non-numeric page', async () => {
    const response = await request(app).get('/api/items?page=abc').set('Cookie', librarianCookie);
    expect(response.status).toBe(400);
  });

  it('paginates deterministically when the sort field has duplicates', async () => {
    // Every one of these sorts identically on `title`; only the id tiebreaker
    // stops them shuffling between requests, which would make offset pagination
    // silently skip and repeat rows.
    await prisma.catalogueItem.deleteMany({});
    for (let i = 0; i < 6; i += 1) {
      await seedItem(librarianId, { title: 'Same title', code: `DUP-${i}` });
    }

    const pageOne = await request(app).get('/api/items?pageSize=3&page=1').set('Cookie', librarianCookie);
    const pageTwo = await request(app).get('/api/items?pageSize=3&page=2').set('Cookie', librarianCookie);
    const pageOneAgain = await request(app).get('/api/items?pageSize=3&page=1').set('Cookie', librarianCookie);

    const ids = (r: { body: { rows: { id: string }[] } }) => r.body.rows.map((row) => row.id);

    expect(ids(pageOne)).toEqual(ids(pageOneAgain));
    expect(new Set([...ids(pageOne), ...ids(pageTwo)]).size).toBe(6);
  });
});
