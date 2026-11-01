import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The app shows its own version and compares it against the latest release, so
// package.json stays the single source of truth for it.
const { version } = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string }

export default defineConfig({
  // Relative base so the built app works from a server subpath AND from file://
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [react()],
  server: {
    // `tauri dev` loads this fixed URL (devUrl in src-tauri/tauri.conf.json).
    port: 5173,
    strictPort: true,
    // Inside Docker (bind-mounted source) file-change events are sometimes not
    // delivered on macOS/Windows hosts; set VITE_USE_POLLING=1 to fall back to
    // polling. No effect on a normal local dev server.
    watch: {
      usePolling: process.env.VITE_USE_POLLING === '1',
    },
  },
  build: {
    outDir: 'dist',
    // Tauri embeds every file in dist; source maps would only grow the binary.
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    // The integration suite (src/test/integration/) spins up a real scratch
    // git repo per test and is slow by unit-test standards on purpose — kept
    // out of the default `vitest run` (`npm test`, run on every PR) and run
    // on its own via `npm run test:integration` instead. Setting `exclude`
    // replaces vitest's own default list rather than adding to it, so its
    // usual entries are repeated here alongside ours.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/*.integration.test.{ts,tsx}',
    ],
  },
})
