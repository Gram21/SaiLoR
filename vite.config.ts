import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

// When ELECTRON=1 we additionally build the Electron main/preload processes and
// launch the desktop shell. Without it, `vite` produces a plain static SPA that
// can be served from any web server (browser deployment).
const isElectron = process.env.ELECTRON === '1'

// The app shows its own version and compares it against the latest release, so
// package.json stays the single source of truth for it.
const { version } = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string }

export default defineConfig({
  // Relative base so the built app works from a server subpath AND from file://
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
    react(),
    ...(isElectron
      ? [
          electron({
            main: {
              entry: 'electron/main.ts',
            },
            preload: {
              input: 'electron/preload.ts',
              // Emit CJS with a .cjs extension: preload scripts load as CommonJS,
              // and the package is type:module so a .js/.mjs would be treated as ESM.
              vite: {
                build: {
                  rollupOptions: {
                    output: { format: 'cjs', entryFileNames: '[name].cjs' },
                  },
                },
              },
            },
            // Renderer stays a normal web build; no Node in the renderer, so we
            // deliberately omit the `renderer` transform option.
          }),
        ]
      : []),
  ],
  server: {
    // Inside Docker (bind-mounted source) file-change events are sometimes not
    // delivered on macOS/Windows hosts; set VITE_USE_POLLING=1 to fall back to
    // polling. No effect on a normal local dev server.
    watch: {
      usePolling: process.env.VITE_USE_POLLING === '1',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
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
