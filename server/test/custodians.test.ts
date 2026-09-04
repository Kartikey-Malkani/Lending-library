import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { loginAs, seedItem } from './helpers/items.js';
import { createLibrarian, createMember, LIBRARIAN_PASSWORD, MEMBER_PASSWORD } from './helpers/users.js';

const app = createApp();

let alexId: string;
let priyaId: string;
let memberId: string;
let alexCookie: string;
let memberCookie: string;

beforeEach(async () => {
  alexId = (await createLibrarian('alex@test.local')).id;
  priyaId = (await createLibrarian('priya@test.local')).id;
  memberId = (await createMember('sam@test.local')).id;
  alexCookie = await loginAs(app, 'alex@test.local', LIBRARIAN_PASSWORD);
  memberCookie = await loginAs(app, 'sam@test.local', MEMBER_PASSWORD);
});

function setCustodians(itemId: string, librarianIds: string[], cookie: string) {
  return request(app)
    .put(`/api/items/${itemId}/custodians`)
    .set('Cookie', cookie)
    .send({ librarianIds });
}

describe('the many-to-many relationship', () => {
  it('assigns several librarians to one item', async () => {
    const item = await seedItem(alexId);

    const response = await setCustodians(item.id, [alexId, priyaId], alexCookie);

    expect(response.status).toBe(200);
    expect(response.body.custodians).toHaveLength(2);
    expect(response.body.custodians.map((c: { id: string }) => c.id).sort()).toEqual(
      [alexId, priyaId].sort(),
    );
  });

  it('makes one librarian custodian of several items', async () => {
    const first = await seedItem(alexId, { title: 'First' });
    const second = await seedItem(alexId, { title: 'Second' });

    await setCustodians(first.id, [priyaId], alexCookie);
    await setCustodians(second.id, [priyaId], alexCookie);

    const mine = await request(app)
      .get('/api/items/mine')
      .set('Cookie', await loginAs(app, 'priya@test.local', LIBRARIAN_PASSWORD));

    expect(mine.status).toBe(200);
    expect(mine.body.total).toBe(2);
    expect(mine.body.rows.map((r: { title: string }) => r.title)).toEqual(['First', 'Second']);
  });

  it('records who made the assignment, from the session', async () => {
    const item = await seedItem(alexId);
    await setCustodians(item.id, [priyaId], alexCookie);

    const link = await prisma.itemCustodian.findFirstOrThrow({ where: { itemId: item.id } });
    expect(link.assignedById).toBe(alexId);
  });
});

describe('set replacement is idempotent', () => {
  it('treats the same set sent twice as a no-op', async () => {
    const item = await seedItem(alexId);

    const first = await setCustodians(item.id, [alexId, priyaId], alexCookie);
    const assignedAt = first.body.custodians.map((c: { assignedAt: string }) => c.assignedAt);

    const second = await setCustodians(item.id, [alexId, priyaId], alexCookie);

    expect(second.status).toBe(200);
    expect(second.body.custodians).toHaveLength(2);
    // Untouched rows keep their original assignment timestamps.
    expect(second.body.custodians.map((c: { assignedAt: string }) => c.assignedAt)).toEqual(assignedAt);
    expect(await prisma.itemCustodian.count({ where: { itemId: item.id } })).toBe(2);
  });

  it('deduplicates repeated ids in the request', async () => {
    const item = await seedItem(alexId);

    const response = await setCustodians(item.id, [alexId, alexId, alexId], alexCookie);

    expect(response.status).toBe(200);
    expect(response.body.custodians).toHaveLength(1);
    expect(await prisma.itemCustodian.count({ where: { itemId: item.id } })).toBe(1);
  });

  it('adds and removes in one step, leaving no orphaned rows', async () => {
    const item = await seedItem(alexId);
    await setCustodians(item.id, [alexId, priyaId], alexCookie);

    const response = await setCustodians(item.id, [priyaId], alexCookie);

    expect(response.status).toBe(200);
    expect(response.body.custodians.map((c: { id: string }) => c.id)).toEqual([priyaId]);

    const rows = await prisma.itemCustodian.findMany({ where: { itemId: item.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.librarianId).toBe(priyaId);
  });

  it('clears the set when given an empty array', async () => {
    const item = await seedItem(alexId);
    await setCustodians(item.id, [alexId, priyaId], alexCookie);

    const response = await setCustodians(item.id, [], alexCookie);

    expect(response.status).toBe(200);
    expect(response.body.custodians).toEqual([]);
    expect(await prisma.itemCustodian.count({ where: { itemId: item.id } })).toBe(0);
  });

  it('leaves no join rows referring to a missing item or librarian', async () => {
    const item = await seedItem(alexId);
    await setCustodians(item.id, [alexId, priyaId], alexCookie);
    await setCustodians(item.id, [], alexCookie);

    const orphans = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) AS count
         FROM item_custodians ic
         LEFT JOIN catalogue_items i ON i.id = ic.item_id
         LEFT JOIN users u ON u.id = ic.librarian_id
        WHERE i.id IS NULL OR u.id IS NULL`,
    );
    expect(Number(orphans[0]!.count)).toBe(0);
  });
});

describe('validation happens before anything is written', () => {
  it('rejects a non-librarian id with 400 and leaves the existing set unchanged', async () => {
    const item = await seedItem(alexId);
    await setCustodians(item.id, [alexId, priyaId], alexCookie);

    const response = await setCustodians(item.id, [priyaId, memberId], alexCookie);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('No changes were made');
    expect(
      response.body.error.details.some((d: { message: string }) => d.message.includes('not a librarian')),
    ).toBe(true);

    // The critical assertion: the original set survived intact. A naive
    // implementation that deletes first and then validates would have wiped it.
    const remaining = await prisma.itemCustodian.findMany({
      where: { itemId: item.id },
      orderBy: { librarianId: 'asc' },
    });
    expect(remaining.map((r) => r.librarianId).sort()).toEqual([alexId, priyaId].sort());
  });

  it('rejects an unknown user id and leaves the existing set unchanged', async () => {
    const item = await seedItem(alexId);
    await setCustodians(item.id, [alexId], alexCookie);

    const response = await setCustodians(
      item.id,
      ['11111111-1111-4111-8111-111111111111'],
      alexCookie,
    );

    expect(response.status).toBe(400);
    expect(
      response.body.error.details.some((d: { message: string }) => d.message.includes('No such user')),
    ).toBe(true);

    const remaining = await prisma.itemCustodian.findMany({ where: { itemId: item.id } });
    expect(remaining.map((r) => r.librarianId)).toEqual([alexId]);
  });

  it('rejects a malformed body', async () => {
    const item = await seedItem(alexId);

    const attempts = [
      { librarianIds: 'not-an-array' },
      { librarianIds: ['not-a-uuid'] },
      { wrongField: [] },
      {},
    ];

    for (const body of attempts) {
      const response = await request(app)
        .put(`/api/items/${item.id}/custodians`)
        .set('Cookie', alexCookie)
        .send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('returns 404 for an unknown item without touching anything', async () => {
    const response = await setCustodians(
      '11111111-1111-4111-8111-111111111111',
      [alexId],
      alexCookie,
    );

    expect(response.status).toBe(404);
    expect(await prisma.itemCustodian.count()).toBe(0);
  });
});

describe('custodian authorization', () => {
  it('refuses a member, whichever ids they supply', async () => {
    const item = await seedItem(alexId);
    await setCustodians(item.id, [alexId], alexCookie);

    // Trying to make themselves a custodian, and trying to remove a real one.
    for (const ids of [[memberId], [], [alexId, memberId]]) {
      const response = await setCustodians(item.id, ids, memberCookie);
      expect(response.status).toBe(403);
    }

    const remaining = await prisma.itemCustodian.findMany({ where: { itemId: item.id } });
    expect(remaining.map((r) => r.librarianId)).toEqual([alexId]);
  });

  it('lets any librarian manage any item, custodian or not', async () => {
    // Custodianship is responsibility, not permission. Alex is not a custodian
    // of this item and may still manage it.
    const item = await seedItem(alexId);
    await setCustodians(item.id, [priyaId], alexCookie);

    const response = await setCustodians(item.id, [priyaId, alexId], alexCookie);
    expect(response.status).toBe(200);
    expect(response.body.custodians).toHaveLength(2);
  });

  it('scopes /items/mine to the caller and ignores any id in the query', async () => {
    const alexItem = await seedItem(alexId, { title: "Alex's item" });
    const priyaItem = await seedItem(alexId, { title: "Priya's item" });
    await setCustodians(alexItem.id, [alexId], alexCookie);
    await setCustodians(priyaItem.id, [priyaId], alexCookie);

    const response = await request(app)
      .get(`/api/items/mine?librarianId=${priyaId}&userId=${priyaId}`)
      .set('Cookie', alexCookie);

    expect(response.status).toBe(200);
    expect(response.body.rows.map((r: { title: string }) => r.title)).toEqual(["Alex's item"]);
  });

  it('excludes archived items from /items/mine by default but can include them', async () => {
    const active = await seedItem(alexId, { title: 'Active' });
    const archived = await seedItem(alexId, { title: 'Archived', archivedAt: new Date() });
    await setCustodians(active.id, [alexId], alexCookie);
    await setCustodians(archived.id, [alexId], alexCookie);

    const byDefault = await request(app).get('/api/items/mine').set('Cookie', alexCookie);
    expect(byDefault.body.rows.map((r: { title: string }) => r.title)).toEqual(['Active']);

    const all = await request(app).get('/api/items/mine?archived=all').set('Cookie', alexCookie);
    expect(all.body.total).toBe(2);
  });
});
