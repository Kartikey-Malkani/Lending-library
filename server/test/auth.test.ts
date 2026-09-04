import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { adminPrisma } from './admin.js';
import {
  createLibrarian,
  createMember,
  LIBRARIAN_PASSWORD,
  MEMBER_PASSWORD,
} from './helpers/users.js';

/**
 * Authentication, driven through the real app: the same middleware order,
 * cookie handling and error envelope a browser gets.
 */

const app = createApp();

/** Extracts the session cookie from a login response. */
function sessionCookie(response: request.Response): string {
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookies.find((c) => c.startsWith(`${config.session.cookieName}=`));
  if (!cookie) throw new Error('No session cookie was set.');
  return cookie;
}

async function login(email: string, password: string): Promise<request.Response> {
  return request(app).post('/api/auth/login').send({ email, password });
}

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await createLibrarian('alex@test.local');
    await createMember('sam@test.local');
  });

  it('signs a librarian in and returns their role', async () => {
    const response = await login('alex@test.local', LIBRARIAN_PASSWORD);

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ email: 'alex@test.local', role: 'librarian' });
    expect(response.body.user.passwordHash).toBeUndefined();
  });

  it('signs a member in and returns their role', async () => {
    const response = await login('sam@test.local', MEMBER_PASSWORD);

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ email: 'sam@test.local', role: 'member' });
  });

  it('accepts an email in any case', async () => {
    const response = await login('ALEX@TEST.LOCAL', LIBRARIAN_PASSWORD);
    expect(response.status).toBe(200);
  });

  it('sets an httpOnly session cookie with a token that is not stored verbatim', async () => {
    const response = await login('alex@test.local', LIBRARIAN_PASSWORD);
    const cookie = sessionCookie(response);

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
    // Local development runs over plain HTTP, so Secure is off outside production.
    expect(cookie).not.toMatch(/Secure/i);

    // The database must hold the HMAC, never the token the client received.
    const token = decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!);
    const stored = await prisma.session.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).not.toBe(token);
    expect(stored[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a wrong password and an unknown address identically', async () => {
    const wrongPassword = await login('alex@test.local', 'not-the-password');
    const unknownUser = await login('nobody@test.local', 'not-the-password');

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    // Identical bodies: the login form must not become a way to discover which
    // addresses have accounts.
    expect(unknownUser.body).toEqual(wrongPassword.body);
    expect(wrongPassword.body.error.code).toBe('invalid_credentials');
  });

  it('creates no session when credentials are rejected', async () => {
    await login('alex@test.local', 'not-the-password');
    expect(await prisma.session.count()).toBe(0);
  });

  it('rejects a malformed body with 400 rather than 500', async () => {
    const response = await request(app).post('/api/auth/login').send({ email: 'alex@test.local' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('bad_request');
  });
});

describe('GET /api/auth/me', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const response = await request(app).get('/api/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthenticated');
  });

  it('rejects a forged session token with 401', async () => {
    await createLibrarian('alex@test.local');
    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${config.session.cookieName}=not-a-real-token`);

    expect(response.status).toBe(401);
  });

  it('returns the signed-in user, and the session persists across requests', async () => {
    await createLibrarian('alex@test.local');
    const cookie = sessionCookie(await login('alex@test.local', LIBRARIAN_PASSWORD));

    for (let i = 0; i < 3; i += 1) {
      const response = await request(app).get('/api/auth/me').set('Cookie', cookie);
      expect(response.status).toBe(200);
      expect(response.body.user).toMatchObject({ email: 'alex@test.local', role: 'librarian' });
    }
  });

  it('rejects a session whose expiry has passed', async () => {
    await createLibrarian('alex@test.local');
    const cookie = sessionCookie(await login('alex@test.local', LIBRARIAN_PASSWORD));

    // Expiry is evaluated when the session is read, so moving it into the past
    // is enough — no background sweep is involved.
    //
    // Done on the OWNER connection because the application role has no UPDATE
    // privilege on sessions: the app can create and destroy sessions but not
    // silently extend or alter one. Reaching for adminPrisma here is the proof.
    await adminPrisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(response.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('deletes the server-side session, not just the cookie', async () => {
    await createLibrarian('alex@test.local');
    const cookie = sessionCookie(await login('alex@test.local', LIBRARIAN_PASSWORD));
    expect(await prisma.session.count()).toBe(1);

    const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(logout.status).toBe(204);

    // The row is gone. This is the whole reason for server-side sessions: a
    // stateless token would still be valid here.
    expect(await prisma.session.count()).toBe(0);
  });

  it('makes the old cookie stop working', async () => {
    await createLibrarian('alex@test.local');
    const cookie = sessionCookie(await login('alex@test.local', LIBRARIAN_PASSWORD));

    await request(app).post('/api/auth/logout').set('Cookie', cookie);

    const afterLogout = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(afterLogout.status).toBe(401);
  });

  it('rejects an unauthenticated logout with 401', async () => {
    const response = await request(app).post('/api/auth/logout');
    expect(response.status).toBe(401);
  });

  it('leaves other sessions of the same user alone', async () => {
    await createLibrarian('alex@test.local');
    const first = sessionCookie(await login('alex@test.local', LIBRARIAN_PASSWORD));
    const second = sessionCookie(await login('alex@test.local', LIBRARIAN_PASSWORD));
    expect(await prisma.session.count()).toBe(2);

    await request(app).post('/api/auth/logout').set('Cookie', first);

    expect(await request(app).get('/api/auth/me').set('Cookie', first).then((r) => r.status)).toBe(401);
    expect(await request(app).get('/api/auth/me').set('Cookie', second).then((r) => r.status)).toBe(200);
  });
});
