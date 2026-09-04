import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyBaseMiddleware } from '../src/app.js';
import {
  assertCanAccessOwnedResource,
  currentUser,
  requireAuth,
  requireCapability,
  resolveBorrowerId,
  resolveBorrowerScope,
} from '../src/auth/middleware.js';
import { ALL_CAPABILITIES, CAPABILITIES, roleHasCapability } from '../src/auth/policy.js';
import { config } from '../src/config.js';
import { errorHandler } from '../src/http/errors.js';
import { createApp } from '../src/app.js';
import { createLibrarian, createMember, LIBRARIAN_PASSWORD, MEMBER_PASSWORD } from './helpers/users.js';

/**
 * Authorization.
 *
 * Two halves, tested differently:
 *
 *  - The capability matrix is data, so it is asserted directly and
 *    exhaustively. If a capability is added without a decision about who may
 *    use it, the matrix test says so.
 *  - The guards need routes to protect, and the feature endpoints they will
 *    protect do not exist yet. Rather than inventing production endpoints early
 *    just to have something to test, the probe app below mounts the real guards
 *    on the real middleware stack (`applyBaseMiddleware`, the same function
 *    `createApp` uses), so ordering bugs are still caught and nothing test-only
 *    reaches the production API.
 */

const realApp = createApp();

/** Stands in for a loan: something with an owner, which a member may only read if it is theirs. */
const OWNED_RESOURCES: Record<string, { ownerId: string }> = {};

function buildProbeApp(): Express {
  const app = express();
  applyBaseMiddleware(app);

  app.get('/probe/any-authenticated', requireAuth, (req, res) => {
    res.json({ userId: currentUser(req).userId });
  });

  // One probe route per capability, so a guard can be exercised for every entry
  // in the matrix without guessing which future route will carry it.
  for (const capability of ALL_CAPABILITIES) {
    app.get(`/probe/capability/${encodeURIComponent(capability)}`, requireCapability(capability), (_req, res) => {
      res.json({ ok: true });
    });
  }

  // Ownership: the owner id comes from server-side data, never the request.
  app.get('/probe/owned/:id', requireCapability('loan:read'), (req, res) => {
    const id = String(req.params.id ?? '');
    const resource = OWNED_RESOURCES[id];
    if (!resource) {
      res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    assertCanAccessOwnedResource(req, resource.ownerId);
    res.json({ id, ownerId: resource.ownerId });
  });

  // Attribution: who a write is recorded against.
  app.post('/probe/borrower', requireCapability('loan:request'), (req, res) => {
    res.json({ borrowerId: resolveBorrowerId(req, (req.body as { borrowerId?: string }).borrowerId) });
  });

  // Scoping: what a list query is filtered to.
  app.get('/probe/scope', requireCapability('loan:read'), (req, res) => {
    res.json({ scope: resolveBorrowerScope(req, req.query.borrowerId as string | undefined) ?? null });
  });

  app.use(errorHandler);
  return app;
}

const probeApp = buildProbeApp();

async function loginAs(email: string, password: string): Promise<string> {
  const response = await request(realApp).post('/api/auth/login').send({ email, password });
  expect(response.status).toBe(200);
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookies.find((c) => c.startsWith(`${config.session.cookieName}=`));
  if (!cookie) throw new Error('No session cookie was set.');
  return cookie;
}

let librarianId: string;
let memberId: string;
let otherMemberId: string;
let librarianCookie: string;
let memberCookie: string;

beforeEach(async () => {
  for (const key of Object.keys(OWNED_RESOURCES)) delete OWNED_RESOURCES[key];

  librarianId = (await createLibrarian('alex@test.local')).id;
  memberId = (await createMember('sam@test.local')).id;
  otherMemberId = (await createMember('dana@test.local')).id;

  librarianCookie = await loginAs('alex@test.local', LIBRARIAN_PASSWORD);
  memberCookie = await loginAs('sam@test.local', MEMBER_PASSWORD);

  OWNED_RESOURCES['owned-by-sam'] = { ownerId: memberId };
  OWNED_RESOURCES['owned-by-dana'] = { ownerId: otherMemberId };
});

describe('the capability matrix', () => {
  it('grants librarians every capability', () => {
    for (const capability of ALL_CAPABILITIES) {
      expect(roleHasCapability('librarian', capability), `librarian should have ${capability}`).toBe(true);
    }
  });

  it('grants members exactly the capabilities the brief gives them', () => {
    const memberCapabilities = ALL_CAPABILITIES.filter((c) => roleHasCapability('member', c)).sort();

    // Spelled out rather than derived, so widening a member's reach requires
    // editing this list and thinking about why.
    expect(memberCapabilities).toEqual(
      ['auth:session', 'catalogue:read', 'loan:read', 'loan:request'].sort(),
    );
  });

  it('denies members every librarian-only capability', () => {
    const librarianOnly = [
      'catalogue:write',
      'catalogue:archive',
      'custodian:manage',
      'custodian:read-own',
      'loan:create-issued',
      'loan:issue',
      'loan:return',
      'loan:lost',
      'bulk:import',
      'bulk:return',
      'export:on-loan',
      'dashboard:read',
      'alerts:read',
      'alerts:dismiss',
    ] as const;

    for (const capability of librarianOnly) {
      expect(roleHasCapability('member', capability), `member must not have ${capability}`).toBe(false);
    }
  });

  it('assigns every capability at least one role', () => {
    for (const capability of ALL_CAPABILITIES) {
      expect(CAPABILITIES[capability].length, `${capability} is unreachable`).toBeGreaterThan(0);
    }
  });
});

describe('guards enforce the matrix over HTTP', () => {
  it('rejects an unauthenticated request to every capability with 401', async () => {
    for (const capability of ALL_CAPABILITIES) {
      const response = await request(probeApp).get(`/probe/capability/${encodeURIComponent(capability)}`);
      expect(response.status, `${capability} unauthenticated`).toBe(401);
      expect(response.body.error.code).toBe('unauthenticated');
    }
  });

  it('lets a librarian through every capability', async () => {
    for (const capability of ALL_CAPABILITIES) {
      const response = await request(probeApp)
        .get(`/probe/capability/${encodeURIComponent(capability)}`)
        .set('Cookie', librarianCookie);
      expect(response.status, `librarian ${capability}`).toBe(200);
    }
  });

  it('gives a member 403 on exactly the capabilities they lack, and 200 on the rest', async () => {
    for (const capability of ALL_CAPABILITIES) {
      const response = await request(probeApp)
        .get(`/probe/capability/${encodeURIComponent(capability)}`)
        .set('Cookie', memberCookie);

      const expected = roleHasCapability('member', capability) ? 200 : 403;
      expect(response.status, `member ${capability}`).toBe(expected);
      if (expected === 403) expect(response.body.error.code).toBe('forbidden');
    }
  });

  it('separates 401 from 403 so a client can tell a timeout from a permission error', async () => {
    const unauthenticated = await request(probeApp).get('/probe/capability/dashboard%3Aread');
    const forbidden = await request(probeApp)
      .get('/probe/capability/dashboard%3Aread')
      .set('Cookie', memberCookie);

    expect(unauthenticated.status).toBe(401);
    expect(forbidden.status).toBe(403);
  });
});

describe('ownership is enforced separately from role', () => {
  it('lets a member read their own resource', async () => {
    const response = await request(probeApp).get('/probe/owned/owned-by-sam').set('Cookie', memberCookie);

    expect(response.status).toBe(200);
    expect(response.body.ownerId).toBe(memberId);
  });

  it("refuses a member another member's resource, even with a valid id", async () => {
    const response = await request(probeApp).get('/probe/owned/owned-by-dana').set('Cookie', memberCookie);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('lets a librarian read anyone’s resource', async () => {
    for (const id of ['owned-by-sam', 'owned-by-dana']) {
      const response = await request(probeApp).get(`/probe/owned/${id}`).set('Cookie', librarianCookie);
      expect(response.status).toBe(200);
    }
  });
});

describe('request parameters cannot widen access', () => {
  it('ignores a borrowerId a member supplies in the body', async () => {
    const response = await request(probeApp)
      .post('/probe/borrower')
      .set('Cookie', memberCookie)
      .send({ borrowerId: otherMemberId });

    expect(response.status).toBe(200);
    // The member's own id, not the one they asked for.
    expect(response.body.borrowerId).toBe(memberId);
    expect(response.body.borrowerId).not.toBe(otherMemberId);
  });

  it('ignores a borrowerId a member supplies in the query string', async () => {
    const response = await request(probeApp)
      .get('/probe/scope')
      .query({ borrowerId: otherMemberId })
      .set('Cookie', memberCookie);

    expect(response.status).toBe(200);
    expect(response.body.scope).toBe(memberId);
  });

  it('honours a borrowerId from a librarian, who is allowed to act for others', async () => {
    const response = await request(probeApp)
      .post('/probe/borrower')
      .set('Cookie', librarianCookie)
      .send({ borrowerId: memberId });

    expect(response.status).toBe(200);
    expect(response.body.borrowerId).toBe(memberId);
  });

  it('leaves a librarian list unscoped when no borrower is requested', async () => {
    const response = await request(probeApp).get('/probe/scope').set('Cookie', librarianCookie);

    expect(response.status).toBe(200);
    expect(response.body.scope).toBeNull();
  });

  it('ignores a role claimed in the body, query string or headers', async () => {
    const attempts = [
      request(probeApp)
        .get('/probe/capability/dashboard%3Aread')
        .set('Cookie', memberCookie)
        .query({ role: 'librarian' }),
      request(probeApp)
        .get('/probe/capability/dashboard%3Aread')
        .set('Cookie', memberCookie)
        .set('X-Role', 'librarian'),
      request(probeApp)
        .get('/probe/capability/dashboard%3Aread')
        .set('Cookie', memberCookie)
        .set('X-User-Id', librarianId),
    ];

    for (const attempt of attempts) {
      const response = await attempt;
      expect(response.status).toBe(403);
    }
  });

  it('ignores a userId claimed alongside a valid member session', async () => {
    const response = await request(probeApp)
      .get('/probe/owned/owned-by-dana')
      .set('Cookie', memberCookie)
      .query({ userId: otherMemberId });

    expect(response.status).toBe(403);
  });

  it('does not accept a second session cookie appended by the client', async () => {
    const response = await request(probeApp)
      .get('/probe/capability/dashboard%3Aread')
      .set('Cookie', `${memberCookie.split(';')[0]}; ${librarianCookie.split(';')[0]}`);

    // Whichever cookie wins, it must be a real session and must not combine
    // privileges. A member session must never yield 200 here.
    expect([200, 403]).toContain(response.status);
    if (response.status === 200) {
      const who = await request(probeApp)
        .get('/probe/any-authenticated')
        .set('Cookie', `${memberCookie.split(';')[0]}; ${librarianCookie.split(';')[0]}`);
      expect(who.body.userId).toBe(librarianId);
    }
  });
});
