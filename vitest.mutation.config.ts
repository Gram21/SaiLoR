import { defineConfig } from 'vitest/config'
import viteConfig from './vite.config'

const base = viteConfig({ command: 'serve', mode: 'test' })

// Stryker (`npm run test:mutation`) runs the unit suite against instrumented,
// slower code. Wall-clock perf tests would fail there for no real reason.
export default defineConfig({
  ...base,
  test: { ...base.test, exclude: [...(base.test?.exclude ?? []), '**/*.perf.test.{ts,tsx}'] },
})
