import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Electron smoke test: real main process, real `contextBridge`-exposed
 * `window.slr`, real `ipcMain` handlers, real filesystem — none of which the
 * jsdom+React-Testing-Library integration suite in src/test/integration/ can
 * exercise, since it mocks `getPlatform()` entirely. This test drives the
 * two IPC calls directly (`window.slr.openPath`/`window.slr.saveProject`)
 * rather than through the rendered UI: that UI-level behavior is already
 * covered elsewhere, and the native "Open"/"Save" dialogs a real user click
 * would hit are exactly the one thing Playwright can't drive here — hence
 * calling the bridge methods a menu click would eventually reach instead.
 *
 * Also exercises a real guard: `electron/main.ts`'s `project:save` handler
 * refuses to write to any path that wasn't first opened via
 * `project:open`/`project:openPath` (`knownProjectPaths`) — so this only
 * passes if `openPath` really did run first and really did reach the main
 * process.
 */

let tmpDir: string
let projectPath: string

test.beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sailor-e2e-'))
  projectPath = join(tmpDir, 'project.json')
  writeFileSync(
    projectPath,
    JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'Study Type', type: 'string' }] },
      papers: [],
    }),
  )
})

test.afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

test('opens a project by path and saves it back through real IPC', async () => {
  const app = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js')] })
  const page = await app.firstWindow()

  const opened = await page.evaluate(
    (p) => (globalThis as unknown as { slr: { openPath(path: string): Promise<{ path: string; text: string } | null> } }).slr.openPath(p),
    projectPath,
  )
  expect(opened).not.toBeNull()
  expect(opened!.path).toBe(projectPath)
  const openedRaw = JSON.parse(opened!.text) as { papers: unknown[] }
  expect(openedRaw.papers).toEqual([])

  // A save to a path that was never opened is refused by the main process
  // (`knownProjectPaths`) — proves the guard itself is real, not vacuously
  // passing because nothing checks it.
  const untrackedPath = join(tmpDir, 'never-opened.json')
  writeFileSync(untrackedPath, '{}')
  const refused = await page.evaluate(
    (p) =>
      (globalThis as unknown as { slr: { saveProject(path: string, meta: string, files: unknown[]): Promise<void> } }).slr
        .saveProject(p, '{}', [])
        .then(() => 'ok')
        .catch((err: Error) => err.message),
    untrackedPath,
  )
  expect(refused).toMatch(/was not opened or chosen/)

  // The real save: now that `projectPath` was opened above, this must
  // succeed and actually write through the real IPC handler.
  const newMeta = JSON.stringify(
    { version: 1, config: { schema: [{ name: 'Study Type', type: 'string' }] }, papers: [{ id: 'p1', title: 'New Paper', authors: [], pdf: '' }] },
    null,
    2,
  )
  await page.evaluate(
    (args: { path: string; meta: string }) =>
      (globalThis as unknown as { slr: { saveProject(path: string, meta: string, files: unknown[]): Promise<void> } }).slr.saveProject(
        args.path,
        args.meta,
        [],
      ),
    { path: projectPath, meta: newMeta },
  )

  const onDisk = JSON.parse(readFileSync(projectPath, 'utf-8')) as { papers: Array<{ title: string }> }
  expect(onDisk.papers[0]?.title).toBe('New Paper')
  expect(existsSync(join(tmpDir, 'annotations'))).toBe(true)

  await app.close()
})

test('real git IPC round-trip: probe and status through the hardened runGit wrapper', async () => {
  // Both jsdom integration tests fake `GitPlatform` entirely — this is the
  // only test that reaches electron/main.ts's actual `runGit`/`gitEnv`/
  // `GIT_SAFE_CONFIG` wrapper (which strips GIT_DIR, disables hooks/pager/
  // ext-diff, etc. — see that file's own comments) through the real
  // contextBridge/IPC path.
  const app = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js')] })
  const page = await app.firstWindow()

  const probe = await page.evaluate(
    () => (globalThis as unknown as { slr: { gitProbe(): Promise<{ available: boolean; version: string; error: string }> } }).slr.gitProbe(),
  )
  expect(probe.available).toBe(true)
  expect(probe.version).toMatch(/git version/)

  execFileSync('git', ['init'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: tmpDir })

  const status = await page.evaluate(
    (root) =>
      (globalThis as unknown as { slr: { gitStatus(root: string): Promise<{ porcelain: string; diff: string }> } }).slr.gitStatus(root),
    tmpDir,
  )
  // Untracked, real `git status --porcelain` output for the file the earlier
  // test wrote — proves the IPC call actually ran a real `git` process
  // against this real directory, through the hardened wrapper, not a stub.
  expect(status.porcelain).toContain('project.json')

  await app.close()
})
