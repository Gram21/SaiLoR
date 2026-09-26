import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildScenario } from '../samples/git-scenarios/builder'
import { scenarioNamed } from '../samples/git-scenarios/scenarios'

/**
 * Two of `samples/git-scenarios/` opened in the real app, through the real
 * "Open project…" button: the ones whose whole point is something the app
 * shows on opening. The native file dialog is the one thing Playwright cannot
 * click, so the main process's `dialog.showOpenDialog` answers with the
 * scenario's project file instead.
 */

const cleanup: string[] = []
test.afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

async function openScenario(name: string): Promise<{ app: ElectronApplication; dir: string }> {
  const scenario = scenarioNamed(name)!
  const stage = buildScenario(scenario)
  const userData = mkdtempSync(join(tmpdir(), 'sailor-e2e-userdata-'))
  cleanup.push(stage.dir, userData)
  const app = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${userData}`] })
  const file = join(stage.dir, scenario.open)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
  }, file)
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Open project…' }).click()
  return { app, dir: stage.dir }
}

test('shared-annotations: opening offers to split the folder', async () => {
  const { app } = await openScenario('shared-annotations')
  const page = await app.firstWindow()
  await expect(page.getByText('Give each project its own annotations folder')).toBeVisible()
  await expect(page.getByLabel('Annotations folder for review-copy.json')).toHaveValue('review-copy-annotations')
  await app.close()
})

test("seat-collision: the seat Ben already committed is flagged on Anna's side", async () => {
  const { app } = await openScenario('seat-collision')
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Reviewer 1', exact: true }).click()
  await page.getByText('A study of code review at scale').first().click()
  await expect(page.getByText('has already committed Reviewer 1 for this paper')).toBeVisible()
  await app.close()
})
