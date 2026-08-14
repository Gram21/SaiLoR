import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Explicit push coverage: `pull.integration.test.tsx` (jsdom) only proves a
 * merge commit stays local ("nothing auto-pushed") — this test drives the
 * real `git:push` IPC handler (`electron/main.ts`, plain `git push` through
 * the same hardened `runGit` wrapper the other e2e git tests exercise)
 * against a real bare "origin", and confirms the commit actually lands
 * there by reading the bare repo directly, independent of the app.
 */

let originDir: string
let localDir: string

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

test.beforeAll(() => {
  originDir = mkdtempSync(join(tmpdir(), 'sailor-e2e-push-origin-'))
  execFileSync('git', ['init', '--bare'], { cwd: originDir })

  localDir = mkdtempSync(join(tmpdir(), 'sailor-e2e-push-local-'))
  git(['init'], localDir)
  git(['config', 'user.email', 'test@example.com'], localDir)
  git(['config', 'user.name', 'E2E Test'], localDir)
  git(['commit', '--allow-empty', '-m', 'Initial commit'], localDir)
  const branch = git(['branch', '--show-current'], localDir).trim()
  git(['remote', 'add', 'origin', originDir], localDir)
  // Establishes upstream tracking the same way a reviewer's *first* push
  // would — done here with real git directly, not through the app, so the
  // test below exercises only the IPC handler's own plain `git push` (which
  // deliberately never adds `--set-upstream` itself — see its own comment
  // in electron/main.ts), not the one-time upstream bootstrap.
  git(['push', '-u', 'origin', branch], localDir)
  git(['commit', '--allow-empty', '-m', 'Not yet pushed'], localDir)
})

test.afterAll(() => {
  rmSync(originDir, { recursive: true, force: true })
  rmSync(localDir, { recursive: true, force: true })
})

test('git:push lands a real commit on a real remote', async () => {
  const originBefore = git(['log', '-1', '--format=%s'], originDir).trim()
  expect(originBefore).toBe('Initial commit') // the second commit is local-only so far

  const app = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js')] })
  const page = await app.firstWindow()

  const result = await page.evaluate(
    (root) =>
      (globalThis as unknown as { slr: { gitPush(root: string): Promise<{ ok: boolean; stdout: string; stderr: string }> } }).slr.gitPush(
        root,
      ),
    localDir,
  )
  expect(result.ok).toBe(true)

  await app.close()

  // Read the bare repo directly — independent of the app and of the local
  // clone's own idea of what happened.
  const originAfter = git(['log', '-1', '--format=%s'], originDir).trim()
  expect(originAfter).toBe('Not yet pushed')
})
