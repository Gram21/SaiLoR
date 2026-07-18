import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['_sim/**/*.test.ts'], testTimeout: 120000 } })
