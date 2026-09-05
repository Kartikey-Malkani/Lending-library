import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Frontend tests.
 *
 * A deliberately small suite. The behaviour that matters most here is not what
 * a component renders but what it *sends*: which URL, which method, which body.
 * So the tests stub `fetch` and let the real API client, the real query
 * construction and the real components run against it — a test that mocked
 * `listLoans()` would prove only that the mock was called.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.tsx'],
  },
});
