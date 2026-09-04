import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Environment handling.
 *
 * Two rules drive this file:
 *  - Nothing secret is ever committed. Values come from a git-ignored .env in
 *    development and from real environment variables in production.
 *  - The process fails fast and loudly at startup rather than at the first
 *    request that happens to need a missing variable.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

// A single .env at the repo root serves both workspaces. In production nothing
// is loaded from disk — the host supplies real environment variables.
const dotenvPath = resolve(repoRoot, '.env');
if (existsSync(dotenvPath)) {
  loadDotenv({ path: dotenvPath });
}

const DEV_SESSION_SECRET_PLACEHOLDER = 'dev-only-insecure-secret-change-me';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env for local development, or set it on the host in production.`,
    );
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}".`);
  }
  return parsed;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

// The test suite talks to its own database so it can truncate freely.
const databaseUrl = isTest ? required('TEST_DATABASE_URL') : required('DATABASE_URL');

/**
 * Owner-level connection, used only for migrations, seeding and the test
 * harness reset — never to serve a request.
 *
 * It falls back to the application URL so a host that issues a single database
 * role still works. That fallback is a weaker posture, not an equivalent one:
 * the append-only trigger still holds, but the privilege-level guarantee on
 * loan_events is gone because the application would be connecting as the owner.
 */
const adminDatabaseUrl = isTest
  ? (process.env.TEST_ADMIN_DATABASE_URL ?? databaseUrl)
  : (process.env.ADMIN_DATABASE_URL ?? databaseUrl);

const sessionSecret = isProduction
  ? required('SESSION_SECRET')
  : (process.env.SESSION_SECRET ?? DEV_SESSION_SECRET_PLACEHOLDER);

if (isProduction && sessionSecret === DEV_SESSION_SECRET_PLACEHOLDER) {
  throw new Error(
    'SESSION_SECRET is still the development placeholder. Set a real secret in production.',
  );
}

export const config = {
  nodeEnv,
  isProduction,
  isTest,
  port: optionalNumber('PORT', 4000),
  databaseUrl,
  adminDatabaseUrl,
  /** True when the app connects as a role distinct from the schema owner. */
  usesLeastPrivilegeRole: adminDatabaseUrl !== databaseUrl,
  sessionSecret,
} as const;

export type Config = typeof config;
