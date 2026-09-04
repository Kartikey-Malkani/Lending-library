#!/usr/bin/env node
/**
 * Runs a Prisma CLI command against the OWNER connection.
 *
 * Migrations, studio and introspection all need DDL rights, which the
 * application's role deliberately does not have. Prisma only ever reads the
 * datasource from DATABASE_URL, so this shim loads the repo-root .env and
 * substitutes ADMIN_DATABASE_URL before handing off.
 *
 * Usage: node scripts/prisma-admin.mjs migrate deploy
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(serverDir, '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!adminUrl) {
  console.error(
    'Neither ADMIN_DATABASE_URL nor DATABASE_URL is set. Copy .env.example to .env and run `npm run db:up`.',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/prisma-admin.mjs <prisma args...>');
  process.exit(1);
}

try {
  execFileSync('npx', ['prisma', ...args], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: adminUrl },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
} catch {
  // The Prisma CLI has already printed its own diagnostics.
  process.exit(1);
}
