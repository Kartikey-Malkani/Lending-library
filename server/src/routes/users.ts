import { Router } from 'express';
import { z } from 'zod';
import { requireCapability } from '../auth/middleware.js';
import { prisma } from '../db.js';
import { asyncHandler } from '../http/errors.js';
import { paginationSchema, parseQuery } from '../http/validation.js';

export const usersRouter = Router();

const listQuerySchema = paginationSchema.extend({
  role: z.enum(['librarian', 'member']).optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

/**
 * A directory of accounts, so a librarian can choose a custodian or a borrower
 * by name instead of pasting a uuid.
 *
 * Deliberately minimal. It returns four fields and nothing else — no password
 * hash, no timestamps, no session information — because widening it later is
 * easy and narrowing it after something depends on it is not.
 */
usersRouter.get(
  '/users',
  requireCapability('user:list'),
  asyncHandler(async (req, res) => {
    const query = parseQuery(req, listQuerySchema);

    const where = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { email: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        // `id` last so paging is stable when two people share a name.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: { id: true, name: true, email: true, role: true },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ rows, total, page: query.page, pageSize: query.pageSize });
  }),
);
