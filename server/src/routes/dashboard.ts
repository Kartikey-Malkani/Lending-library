import { Router } from 'express';
import { requireCapability } from '../auth/middleware.js';
import { buildDashboard } from '../dashboard/service.js';
import { asyncHandler } from '../http/errors.js';

export const dashboardRouter = Router();

/**
 * One request paints the whole landing view.
 *
 * The endpoint is single because a dashboard should not need five round trips,
 * not because the aggregation has been moved into the application — every
 * number behind it is a database aggregate.
 */
dashboardRouter.get(
  '/dashboard',
  requireCapability('dashboard:read'),
  asyncHandler(async (_req, res) => {
    res.json(await buildDashboard());
  }),
);
