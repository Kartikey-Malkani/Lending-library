import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { Role } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';

/**
 * Server-side sessions.
 *
 * The cookie carries an opaque random token. The database stores only
 * HMAC-SHA256(token, SESSION_SECRET), never the token itself, so a leaked
 * database dump cannot be replayed as a set of live sessions without also
 * having the secret.
 *
 * This replaces the stateless JWT originally planned. A JWT cannot be revoked:
 * logout can clear the browser's cookie but the token stays valid until it
 * expires, so anyone who copied it keeps access. Deleting a row is a real
 * logout. See docs/decisions.md.
 */

export type AuthenticatedUser = {
  userId: string;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
};

const TOKEN_BYTES = 32;

/** Opaque, unguessable, and never stored anywhere on the server. */
function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashToken(token: string): string {
  return createHmac('sha256', config.sessionSecret).update(token).digest('hex');
}

/**
 * Creates a session and returns the token to hand to the client.
 *
 * The token is returned, never persisted; only its HMAC reaches the database.
 */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + config.session.ttlMs);

  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
  });

  return { token, expiresAt };
}

/**
 * Resolves a token to its user, or null.
 *
 * Expiry is checked here rather than by a background sweep. An expired row is
 * deleted opportunistically when it is encountered, which keeps the table from
 * growing without bound in normal use; genuinely stale rows from sessions that
 * are never revisited are left to operational housekeeping we have not built.
 */
export async function resolveSession(token: string | undefined): Promise<AuthenticatedUser | null> {
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {
      // Another request may have collected it first; nothing to do either way.
    });
    return null;
  }

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    sessionId: session.id,
  };
}

/** Logout. Deletes the row, so the token is dead everywhere, not just in this browser. */
export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** Invalidates every session a user holds. Not yet reachable from a route. */
export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(config.session.cookieName, token, {
    httpOnly: true,
    sameSite: config.session.cookieSameSite,
    secure: config.session.cookieSecure,
    path: '/',
    maxAge: config.session.ttlMs,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(config.session.cookieName, {
    httpOnly: true,
    sameSite: config.session.cookieSameSite,
    secure: config.session.cookieSecure,
    path: '/',
  });
}

/**
 * Constant-time string comparison, exported for tests that need to compare
 * tokens without introducing a timing signal of their own.
 */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
