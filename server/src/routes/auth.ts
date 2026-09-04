import { Router } from 'express';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { readCookie } from '../http/cookies.js';
import { ApiError, asyncHandler } from '../http/errors.js';
import { currentUser, requireCapability } from '../auth/middleware.js';
import { verifyPassword, wasteTimeLikeAPasswordCheck } from '../auth/password.js';
import { clearSessionCookie, createSession, destroySession, setSessionCookie } from '../auth/session.js';

export const authRouter = Router();

/**
 * One rejection for every way a login can fail.
 *
 * Wrong password and unknown address must be indistinguishable, or the login
 * form becomes a tool for discovering who has an account.
 */
function invalidCredentials(): ApiError {
  return new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
}

type LoginBody = { email?: unknown; password?: unknown };

authRouter.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const { email, password } = (req.body ?? {}) as LoginBody;

    if (typeof email !== 'string' || typeof password !== 'string' || email === '' || password === '') {
      throw ApiError.badRequest('Email and password are required.');
    }

    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });

    if (!user) {
      // Spend the same time a real comparison would, so the response does not
      // reveal that this address has no account.
      await wasteTimeLikeAPasswordCheck(password);
      throw invalidCredentials();
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      throw invalidCredentials();
    }

    const { token } = await createSession(user.id);
    setSessionCookie(res, token);

    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  }),
);

authRouter.get(
  '/auth/me',
  requireCapability('auth:session'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({
      user: { id: user.userId, email: user.email, name: user.name, role: user.role },
    });
  }),
);

/**
 * Logout deletes the session row, so the token stops working everywhere rather
 * than only in the browser that asked. Clearing the cookie is the cosmetic half.
 */
authRouter.post(
  '/auth/logout',
  requireCapability('auth:session'),
  asyncHandler(async (req, res) => {
    await destroySession(readCookie(req, config.session.cookieName));
    clearSessionCookie(res);
    res.status(204).end();
  }),
);
