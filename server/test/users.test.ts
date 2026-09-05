import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loginAs } from './helpers/items.js';
import {
  createLibrarian,
  createMember,
  createUser,
  LIBRARIAN_PASSWORD,
  MEMBER_PASSWORD,
} from './helpers/users.js';

/**
 * GET /api/users — a directory so a librarian can pick a custodian or a
 * borrower by name rather than pasting a uuid.
 */

const app = createApp();

type Row = { id: string; name: string; email: string; role: string };

let librarianCookie: string;
let memberCookie: string;

beforeEach(async () => {
  await createLibrarian('alex@test.local');
  await createMember('sam@test.local');
  await createUser({ email: 'priya@test.local', role: 'librarian', password: LIBRARIAN_PASSWORD, name: 'Priya Raman' });
  await createUser({ email: 'dana@test.local', role: 'member', password: MEMBER_PASSWORD, name: 'Dana Feldman' });

  librarianCookie = await loginAs(app, 'alex@test.local', LIBRARIAN_PASSWORD);
  memberCookie = await loginAs(app, 'sam@test.local', MEMBER_PASSWORD);
});

function list(cookie: string, query = '') {
  return request(app).get(`/api/users${query}`).set('Cookie', cookie);
}

describe('authorization', () => {
  it('rejects an unauthenticated request with 401', async () => {
    expect((await request(app).get('/api/users')).status).toBe(401);
  });

  it('rejects a member with 403 — a directory is not their business', async () => {
    const response = await list(memberCookie);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });
});

describe('what it returns', () => {
  it('lists everyone for a librarian', async () => {
    const response = await list(librarianCookie);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(4);
  });

  it('never exposes the password hash or anything beyond the four fields', async () => {
    const response = await list(librarianCookie);

    for (const row of response.body.rows as Row[]) {
      expect(Object.keys(row).sort()).toEqual(['email', 'id', 'name', 'role']);
    }
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/);
  });

  it('filters by role', async () => {
    const librarians = await list(librarianCookie, '?role=librarian');
    const members = await list(librarianCookie, '?role=member');

    expect(librarians.body.total).toBe(2);
    expect(members.body.total).toBe(2);
    expect(librarians.body.rows.every((r: Row) => r.role === 'librarian')).toBe(true);
  });

  it('searches name and email, case-insensitively and partially', async () => {
    for (const term of ['Priya', 'priya', 'riya', 'priya@test']) {
      const response = await list(librarianCookie, `?search=${encodeURIComponent(term)}`);
      expect(response.body.rows.map((r: Row) => r.name), term).toContain('Priya Raman');
    }
  });

  it('combines role and search', async () => {
    const response = await list(librarianCookie, '?role=member&search=test.local');

    expect(response.body.total).toBe(2);
    expect(response.body.rows.every((r: Row) => r.role === 'member')).toBe(true);
  });

  it('returns an empty page with a zero total when nothing matches', async () => {
    const response = await list(librarianCookie, '?search=nobodyhasthisname');

    expect(response.body.rows).toEqual([]);
    expect(response.body.total).toBe(0);
  });

  it('paginates with a true total and rejects nonsense', async () => {
    const page = await list(librarianCookie, '?pageSize=2');
    expect(page.body.rows).toHaveLength(2);
    expect(page.body.total).toBe(4);

    for (const q of ['?page=0', '?pageSize=0', '?role=wizard']) {
      expect((await list(librarianCookie, q)).status, q).toBe(400);
    }
  });
});
