/**
 * Vite configuration for the owner client.
 *
 * The client is a plain single-page app bundled by Vite and served by the Fastify
 * process (ADR 0002: one lean Node runtime for a 2-core ARM64 VM), so the only
 * decision here that matters is where the output lands. `dist/client` is inside the
 * app directory and outside `src`, which keeps the build output out of the source
 * globs under `src` that the type checker and the policy linter walk.
 *
 * The dev server port is configurable because the runbook requires each concurrent
 * worktree to own a real port, but `strictPort` stays false: a taken port must not
 * turn into a confusing crash, and the caller reads the address the server actually
 * bound rather than assuming the one it asked for.
 */

import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const APP_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));

/** Only a well-formed port is honoured; anything else falls back to the default. */
function readDevPort(environment: NodeJS.ProcessEnv): number {
  const raw = environment['SHIPLOOP_DEV_PORT'];
  if (raw === undefined || raw === '') return 5173;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 5173;
}

export default defineConfig({
  root: APP_DIRECTORY,
  plugins: [react()],
  // The Vite dev server proxies nothing: the client calls its own origin, so the
  // bundled UI has no fixed localhost API URL in it (runbook, remote access).
  server: { port: readDevPort(process.env), strictPort: false },
  preview: { port: readDevPort(process.env), strictPort: false },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./index.html', import.meta.url)),
    },
  },
});