import type { AuthenticatedUser } from '../auth/session.js';

/**
 * `req.auth` is populated by attachSession from the session cookie, and is the
 * only source of identity in the application. Nothing reads a user id or role
 * from the request body, query string or headers.
 */
declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedUser;
    }
  }
}

export {};
