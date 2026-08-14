import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Kept separate from the default `vitest run` (`npm test`, run by
// scripts/ci.sh on every PR): this suite spins up a real scratch git
// repository per test and is slower than the pure-logic unit tests. It runs
// on its own via `npm run test:integration`, gated in front of release
// builds — see .github/workflows/release.yml.
//
// A standalone config rather than `mergeConfig` over `vite.config.ts`:
// Vite's `mergeConfig` concatenates array fields like `test.include` rather
// than replacing them, which would silently pull the ~90 existing unit test
// files into this run too.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/test/integration/**/*.integration.test.tsx'],
  },
})
