import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { attachSession } from './auth/middleware.js';
import { ApiError, errorHandler } from './http/errors.js';
import { alertsRouter } from './routes/alerts.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { healthRouter } from './routes/health.js';
import { itemsRouter } from './routes/items.js';
import { loansRouter } from './routes/loans.js';

/**
 * The middleware every request passes through, in order.
 *
 * Exported so the authorization tests can mount their probe routes on the same
 * stack the real app uses. If this ordering were duplicated in the tests, a
 * mistake here — session parsing after the guards, say — would not be caught.
 */
export function applyBaseMiddleware(app: Express): void {
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  // CSV uploads arrive as a raw text body rather than multipart: the client is
  // an SPA that reads the file itself, so a multipart dependency would buy
  // nothing. The limit is what stops a huge upload from occupying the process.
  app.use(express.text({ type: 'text/csv', limit: '1mb' }));
  // Populates req.auth from the session cookie. Does not reject: guards do that.
  app.use(attachSession);
}

/**
 * Builds the Express app without starting a listener.
 *
 * Kept separate from index.ts so the integration tests can drive the real app
 * through supertest — the same middleware stack, routing and error handling a
 * browser hits — instead of testing handlers in isolation.
 */
export function createApp(): Express {
  const app = express();

  applyBaseMiddleware(app);

  app.use('/api', healthRouter);
  app.use('/api', authRouter);
  app.use('/api', itemsRouter);
  app.use('/api', loansRouter);
  app.use('/api', dashboardRouter);
  app.use('/api', alertsRouter);

  // Unknown API routes must not fall through to the SPA below: a mistyped
  // endpoint should be a JSON 404, not an HTML page.
  app.use('/api', (_req, _res, next) => {
    next(ApiError.notFound('Route not found.'));
  });

  serveSpa(app);

  app.use(errorHandler);

  return app;
}

/**
 * Serves the built single-page app from the same process as the API.
 *
 * This is the deployment shape: one origin, so the session cookie stays
 * `SameSite=Lax` and there is no CORS configuration to get wrong. Splitting the
 * SPA onto a second host would force `SameSite=None; Secure` and a cross-site
 * cookie, which is more moving parts and more ways to be broken in front of
 * someone.
 *
 * Mounted after the API and its 404, so `/api/*` is always handled as an API
 * route, and before the error handler.
 *
 * Absent in development, where Vite serves the SPA on its own port and proxies
 * `/api` here. The guard means `npm run dev` does not need a build to exist.
 */
function serveSpa(app: Express): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // Resolves to <repo>/web/dist from both src/ (tsx) and dist/ (compiled).
  const webDist = resolve(here, '..', '..', 'web', 'dist');
  const indexHtml = join(webDist, 'index.html');

  if (!existsSync(indexHtml)) return;

  app.use(express.static(webDist));

  // History fallback: the SPA owns its routes, so a deep link like /loans/:id
  // must return index.html rather than 404 when someone reloads the page.
  app.get('*', (_req, res) => {
    res.sendFile(indexHtml);
  });
}
