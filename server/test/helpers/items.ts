import type { CatalogueItem, LoanStatus } from '@prisma/client';
import request from 'supertest';
import type { Express } from 'express';
import { expect } from 'vitest';
import { config } from '../../src/config.js';
import { prisma } from '../../src/db.js';

/** Signs in through the real app and returns the session cookie header. */
export async function loginAs(
  app: Express,
  email: string,
  password: string,
): Promise<string> {
  const response = await request(app).post('/api/auth/login').send({ email, password });
  expect(response.status, `login for ${email}`).toBe(200);

  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookies.find((c) => c.startsWith(`${config.session.cookieName}=`));
  if (!cookie) throw new Error('No session cookie was set.');
  return cookie;
}

/** Creates an item directly, bypassing the API — for arranging test state. */
export async function seedItem(
  createdById: string,
  overrides: Partial<Pick<CatalogueItem, 'title' | 'category' | 'code' | 'archivedAt'>> = {},
): Promise<CatalogueItem> {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return prisma.catalogueItem.create({
    data: {
      title: overrides.title ?? `Test item ${suffix}`,
      category: overrides.category ?? 'Testing',
      code: (overrides.code ?? `TEST-${suffix}`).toUpperCase(),
      archivedAt: overrides.archivedAt ?? null,
      createdById,
    },
  });
}

/**
 * Creates a loan directly through Prisma.
 *
 * Milestone 3 has no loan endpoints and deliberately does not add any. This
 * exists so the catalogue tests can prove that archiving leaves existing loans
 * untouched, which is a real requirement testable now — without pretending the
 * loan lifecycle is implemented.
 *
 * Every timestamp comes from one `now`, because the chronology CHECK constraint
 * rejects a row whose issued_at precedes a requested_at taken from a different
 * clock.
 */
export async function seedLoan(options: {
  itemId: string;
  borrowerId: string;
  status: LoanStatus;
  librarianId?: string;
}): Promise<{ id: string }> {
  const now = new Date();
  const dueOn = new Date(now.getTime() + 14 * 86_400_000);
  const issued = options.status !== 'requested';

  return prisma.loan.create({
    data: {
      itemId: options.itemId,
      borrowerId: options.borrowerId,
      status: options.status,
      requestedAt: now,
      issuedAt: issued ? now : null,
      dueOn: issued ? dueOn : null,
      returnedAt: options.status === 'returned' ? now : null,
      lostAt: options.status === 'lost' ? now : null,
      issuedById: issued ? (options.librarianId ?? null) : null,
      returnedById: options.status === 'returned' ? (options.librarianId ?? null) : null,
    },
    select: { id: true },
  });
}
