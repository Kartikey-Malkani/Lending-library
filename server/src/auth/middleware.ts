import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { readCookie } from '../http/cookies.js';
import { ApiError, asyncHandler } from '../http/errors.js';
import { type Capability, roleHasCapability } from './policy.js';
import { type AuthenticatedUser, resolveSession } from './session.js';

/**
 * Authentication and authorization guards.
 *
 * Everything here runs on the server, from the session cookie. Nothing is read
 * from the request body, query string or a header the client controls — that is
 * the whole point of goal 1's "must be enforced on the server, not just hidden
 * in the interface". Hiding a button is a courtesy; this is the control.
 */

/** Reads the session cookie if present. Never rejects — that is a guard's job. */
export const attachSession: RequestHandler = asyncHandler(async (req, _res, next) => {
  req.auth = (await resolveSession(readCookie(req, config.session.cookieName))) ?? undefined;
  next();
});

/** Narrows `req.auth` to a signed-in user, or 401. */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.auth) throw ApiError.unauthorized();
  return req.auth;
}

/** Any authenticated user. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) {
    next(ApiError.unauthorized());
    return;
  }
  next();
};

/**
 * Authenticated AND permitted by the capability matrix.
 *
 * 401 and 403 are kept distinct on purpose: "you are not signed in" and "you
 * are signed in and still may not" are different problems for a client, and
 * collapsing them makes the UI unable to tell a session timeout from a
 * permission error.
 */
export function requireCapability(capability: Capability): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      next(ApiError.unauthorized());
      return;
    }
    if (!roleHasCapability(req.auth.role, capability)) {
      next(ApiError.forbidden(`Your role (${req.auth.role}) cannot perform this action.`));
      return;
    }
    next();
  };
}

/**
 * Ownership, which is a separate question from role.
 *
 * A librarian may act on anyone's resource; a member only on their own. The
 * owner id always comes from data the server loaded, never from the request, so
 * changing an id in the URL or body cannot widen access — it can only produce a
 * 403 or a 404.
 */
export function assertCanAccessOwnedResource(req: Request, ownerId: string): AuthenticatedUser {
  const user = currentUser(req);
  if (user.role === 'librarian') return user;
  if (user.userId !== ownerId) {
    throw ApiError.forbidden('You can only access your own records.');
  }
  return user;
}

/**
 * The borrower a write should be attributed to.
 *
 * A librarian may act for another user; a member is always themselves, and any
 * `borrowerId` they supply is discarded rather than validated. Discarding
 * rather than rejecting keeps a member who sends a stray field from getting a
 * confusing error, while making privilege escalation impossible.
 */
export function resolveBorrowerId(req: Request, requestedBorrowerId?: string): string {
  const user = currentUser(req);
  if (user.role === 'librarian' && requestedBorrowerId) return requestedBorrowerId;
  return user.userId;
}

/**
 * The borrower filter a list query should use.
 *
 * Returns undefined for a librarian (no scoping) and the member's own id
 * otherwise, ignoring whatever the client asked for.
 */
export function resolveBorrowerScope(req: Request, requestedBorrowerId?: string): string | undefined {
  const user = currentUser(req);
  if (user.role === 'librarian') return requestedBorrowerId;
  return user.userId;
}
