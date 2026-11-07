import { readdirSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The app shows its own version and compares it against the latest release, so
// package.json stays the single source of truth for it.
const { version } = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string }

export default defineConfig(({ mode }) => {
  // `npm run build:demo` runs `vite build --mode demo`: the online demo, built
  // into dist-demo/. `__DEMO__` is a compile-time constant, so the normal build
  // drops every demo branch.
  const isDemo = mode === 'demo'
  // The demo's PDFs are written as plain files, not imported, so the normal build
  // never contains them. The file names must match DEMO_PDF_FILES in src/demo/project.ts.
  const demoPdfs = {
    name: 'slr-demo-pdfs',
    generateBundle(this: { emitFile: (file: { type: 'asset'; fileName: string; source: Buffer }) => void }) {
      for (const name of readdirSync('./src/demo/papers').filter((file) => file.endsWith('.pdf'))) {
        this.emitFile({
          type: 'asset',
          fileName: `papers/${name}`,
          source: readFileSync(`./src/demo/papers/${name}`),
        })
      }
    },
  }
  return {
    // Relative base so the built app works from a server subpath AND from file://
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __DEMO__: JSON.stringify(isDemo),
    },
    plugins: [react(), ...(isDemo ? [demoPdfs] : [])],
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
      outDir: isDemo ? 'dist-demo' : 'dist',
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
      // Applies only with `--coverage` (`npm run test:coverage`). Floors sit just
      // under the measured baseline, so a drop fails and a rise can raise them.
      coverage: {
        include: ['src/**'],
        exclude: ['**/*.test.{ts,tsx}', 'src/test/**'],
        reporter: ['text-summary', 'json-summary'],
        thresholds: { lines: 82, statements: 82, functions: 76, branches: 84 },
      },
    },
  }
})
