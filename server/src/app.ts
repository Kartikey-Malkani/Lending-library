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

  // Unknown API routes must not fall through to anything else.
  app.use('/api', (_req, _res, next) => {
    next(ApiError.notFound('Route not found.'));
  });

  app.use(errorHandler);

  return app;
}
