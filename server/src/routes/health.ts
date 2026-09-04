import { Router } from 'express';
import { prisma } from '../db.js';

export const healthRouter = Router();

/**
 * Liveness + database reachability.
 *
 * The database round-trip is deliberate: on a free-tier host the process can be
 * up while the managed database is still waking, and "the server responds" is
 * not the same claim as "the system works".
 */
healthRouter.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'down' });
  }
});
