import type { PrismaClient } from '@prisma/client';
import { createAdminClient } from '../src/db.js';

/**
 * Owner-level client, shared across the suite.
 *
 * Two jobs, both of which the application's own role deliberately cannot do:
 *  - truncating tables between tests (the app role has no TRUNCATE anywhere)
 *  - proving the append-only trigger stops even a privileged user
 *
 * Nothing under src/ that serves a request may use this.
 */
export const adminPrisma: PrismaClient = createAdminClient();
