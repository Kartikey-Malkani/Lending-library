import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  /*
   * Deliberately NOT `envDir: '..'`.
   *
   * The root .env is the server's, and it sets NODE_ENV=development. Vite reads
   * NODE_ENV out of any env file it loads and applies it to the build, so
   * pointing envDir at the repo root made `npm run build` locally emit a
   * DEVELOPMENT React bundle — roughly twice the size of the one that actually
   * deploys, where no .env file exists and the host sets NODE_ENV=production.
   * The deployed artifact was always correct; the local build was quietly
   * lying about it.
   *
   * Nothing in web/src reads `import.meta.env`, so the SPA needs no env file at
   * all: the API is same-origin and reached through relative /api paths.
   */
  server: {
    port: 5173,
    // In development the SPA and API run as two processes, so /api is proxied
    // to the server. In production one Node process serves both, and these
    // same relative paths work unchanged — no CORS, no base-URL switching.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
