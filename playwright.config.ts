import { defineConfig } from '@playwright/test'

// Electron smoke tests only — real main process, real contextBridge/IPC, real
// fs. Everything UI-shaped (schema authoring, PDF annotation, git commit) is
// already covered by the jsdom+React-Testing-Library suite in
// src/test/integration/, which is faster and doesn't need a display server.
// This suite exists for the class of bug jsdom structurally cannot see: the
// preload bridge and the main process's IPC handlers actually wired up
// correctly. Requires `dist-electron/main.js` to exist — see
// `npm run test:e2e`, which builds it first.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // One worker: each test launches its own real Electron process, and there
  // is no shared state to race — parallelism would only cost more CPU/RAM for
  // no speed-up worth the complexity.
  workers: 1,
  reporter: 'list',
})
