import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // A single .env at the repo root serves both workspaces.
  envDir: '..',
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
