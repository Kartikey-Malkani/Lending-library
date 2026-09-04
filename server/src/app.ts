import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { healthRouter } from './routes/health.js';

/**
 * Builds the Express app without starting a listener.
 *
 * Kept separate from index.ts so the integration tests can drive the real app
 * through supertest — the same middleware stack, routing and error handling a
 * browser hits — instead of testing handlers in isolation.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', healthRouter);

  // Unknown API routes must not fall through to anything else.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found.' } });
  });

  // Terminal error handler. Never leak a stack trace to a client.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
      error: { code: 'internal_error', message: 'An unexpected error occurred.' },
    });
  });

  return app;
}
