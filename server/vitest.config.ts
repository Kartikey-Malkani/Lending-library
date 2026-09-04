import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite drives a real Express app against a real Postgres. Tests share
    // one database, so they run in a single process to keep truncation between
    // tests deterministic rather than racing parallel workers.
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
