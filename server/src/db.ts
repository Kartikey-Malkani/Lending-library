import { PrismaClient } from '@prisma/client';
import { config } from './config.js';

/**
 * The application's database client.
 *
 * It connects as the least-privilege role, which can read and write the working
 * tables but holds only SELECT and INSERT on loan_events. An attempt to rewrite
 * history from application code fails on privilege before it ever reaches the
 * append-only trigger.
 *
 * The datasource URL is passed explicitly rather than read from the ambient
 * DATABASE_URL so that a test run (NODE_ENV=test) is pointed at
 * TEST_DATABASE_URL by config.ts. Without this the suite would happily
 * truncate the development database.
 */
export const prisma = new PrismaClient({
  datasources: { db: { url: config.databaseUrl } },
  log: ['warn', 'error'],
});

/**
 * Owner-level client for administrative work only: seeding and the test harness
 * reset. Nothing that serves a request may use this.
 *
 * Deliberately created on demand rather than at module load, so importing this
 * file from request-handling code does not silently open a privileged
 * connection.
 */
export function createAdminClient(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: config.adminDatabaseUrl } },
    log: ['warn', 'error'],
  });
}
