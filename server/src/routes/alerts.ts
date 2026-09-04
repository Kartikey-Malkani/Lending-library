import { Router } from 'express';
import { currentUser, requireCapability } from '../auth/middleware.js';
import { dismissAlert, listAlerts } from '../alerts/service.js';
import { asyncHandler } from '../http/errors.js';
import { paginationSchema, parseQuery, parseUuidParam } from '../http/validation.js';

export const alertsRouter = Router();

/**
 * Overdue loans this librarian has not dismissed.
 *
 * `count` is the full total, not the size of the page, because the navigation
 * badge reads it from this same response — one endpoint, one definition of the
 * number, no chance of the badge and the list disagreeing.
 */
alertsRouter.get(
  '/alerts',
  requireCapability('alerts:read'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parseQuery(req, paginationSchema);
    const user = currentUser(req);

    res.json(await listAlerts({ userId: user.userId, page, pageSize }));
  }),
);

/** Dismissal is per librarian: it never hides the alert from anyone else. */
alertsRouter.post(
  '/alerts/:loanId/dismiss',
  requireCapability('alerts:dismiss'),
  asyncHandler(async (req, res) => {
    const loanId = parseUuidParam(req, 'loanId');
    const user = currentUser(req);

    await dismissAlert({ loanId, userId: user.userId });
    res.status(204).end();
  }),
);
