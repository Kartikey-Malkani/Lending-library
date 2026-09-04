import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/**
 * Runs once before the whole suite: brings the dedicated test database up to
 * the current migration state.
 *
 * `migrate deploy` (not `migrate dev`) is deliberate — it applies committed
 * migrations and never prompts or generates new ones, so the tests exercise
 * exactly the SQL that will run in production, including the CHECK
 * constraints, the partial unique index and the append-only trigger.
 */
export default function setup(): void {
  const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const envPath = resolve(serverRoot, '..', '.env');
  if (existsSync(envPath)) loadDotenv({ path: envPath });

  // Migrations create and alter tables, so they run as the owner. The
  // application's own role has no DDL rights.
  const migrationUrl = process.env.TEST_ADMIN_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!migrationUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env and start the database with `npm run db:up`.',
    );
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: serverRoot,
    // Prisma reads DATABASE_URL from the datasource block, so the test URL is
    // injected here rather than pointing migrations at the development database.
    env: { ...process.env, DATABASE_URL: migrationUrl },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
