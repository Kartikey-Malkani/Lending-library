import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { adminPrisma } from './admin.js';

/**
 * Every test starts from an empty database.
 *
 * The reset runs on the OWNER connection, not the application one. The
 * application role has no TRUNCATE privilege on any table — that is the point
 * of the split — so the suite cannot and should not clean up through it.
 * `db.ts` points the application client at TEST_DATABASE_URL whenever NODE_ENV
 * is `test`, so neither connection can touch development data.
 */
beforeEach(async () => {
  await adminPrisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      alert_dismissals,
      loan_events,
      loans,
      item_custodians,
      catalogue_items,
      users
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), adminPrisma.$disconnect()]);
});
