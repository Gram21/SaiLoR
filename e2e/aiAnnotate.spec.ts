import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { closeApp } from './helpers'

/**
 * Real UI, real Electron, real AI-assisted-annotation flow — against a mock
 * OpenAI-compatible server on localhost. Unlike the other e2e specs (which
 * call `window.slr`'s bridge methods directly), this one drives the actual
 * rendered React app: opening a project through the real "Open" menu (with
 * only `dialog.showOpenDialog` stubbed via `electronApp.evaluate`, since
 * Playwright cannot click a native OS file picker), picking a reviewer seat,
 * selecting a paper, adding an LLM target through `LlmSettingsDialog`, and
 * running the AI dialog to completion in both prompt and agent mode.
 *
 * The mock server's replies are keyed off the shape of each request body
 * (has `tools`? has a `tool` role message yet? is the system prompt the
 * judge's?) — see `src/llm/chat.ts` (`buildChatRequest`/`parseChatResponse`),
 * `src/llm/judge.ts` (`buildJudgeSystemPrompt`), and `src/llm/verify.ts`
 * (`checkSubmission`, which requires agent-mode evidence to be a real quote
 * from the paper's extracted text — hence the evidence strings below are
 * copied verbatim from samples/pdfs/paper-a.pdf).
 */

const STUDY_TYPE_VALUE = 'RCT'
const STUDY_TYPE_EVIDENCE = 'Study Type: RCT'
const YEAR_VALUE = 2021
const YEAR_EVIDENCE = 'Year: 2021'

const JUDGE_MARKER = "You are reviewing another AI's proposed annotations"

const PROMPT_ANSWER = JSON.stringify({
  fields: [
    { path: 'Study Type', value: STUDY_TYPE_VALUE, evidence: STUDY_TYPE_EVIDENCE, confidence: 0.9 },
    { path: 'Year', value: YEAR_VALUE, evidence: YEAR_EVIDENCE, confidence: 0.9 },
  ],
  skipped: [],
})

const JUDGE_ANSWER = JSON.stringify({
  verdicts: [
    { path: 'Study Type', verdict: 'accept', feedback: '' },
    { path: 'Year', verdict: 'accept', feedback: '' },
  ],
  missed: [],
})

const SUBMIT_ARGS = {
  fields: [
    { path: 'Study Type', value: STUDY_TYPE_VALUE, evidence: STUDY_TYPE_EVIDENCE, source: 'paper', confidence: 0.9 },
    { path: 'Year', value: YEAR_VALUE, evidence: YEAR_EVIDENCE, source: 'paper', confidence: 0.9 },
  ],
  skipped: [],
}

function toolCallReply(name: string, args: unknown): unknown {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  }
}

function textReply(text: string): unknown {
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  }
}

interface ChatMessageLike {
  role?: string
  content?: unknown
}

/**
 * Decide the reply for one `/v1/chat/completions` POST purely from the
 * request's own shape — see the module doc comment. One server instance is
 * reused by both tests; nothing here is stateful beyond the request itself.
 */
function mockReplyFor(body: Record<string, unknown>): unknown {
  const messages: ChatMessageLike[] = Array.isArray(body.messages) ? (body.messages as ChatMessageLike[]) : []
  const hasTools = Array.isArray(body.tools) && (body.tools as unknown[]).length > 0

  if (hasTools) {
    const hasToolResult = messages.some((m) => m.role === 'tool')
    return hasToolResult
      ? toolCallReply('submit_annotations', SUBMIT_ARGS)
      : toolCallReply('search_paper', { query: 'Study Type', max: 3 })
  }

  const system = messages.find((m) => m.role === 'system')
  const isJudge = typeof system?.content === 'string' && system.content.includes(JUDGE_MARKER)
  return textReply(isJudge ? JUDGE_ANSWER : PROMPT_ANSWER)
}

function startMockLlmServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as Record<string, unknown>
        } catch {
          // A malformed body just gets the prompt-mode default below.
        }
        const reply = mockReplyFor(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, port })
    })
  })
}

/** A fresh copy of the example project + its PDFs, so nothing ever writes
 *  into samples/ itself. */
function copyProject(): { dir: string; projectPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sailor-e2e-ai-'))
  cpSync(join(process.cwd(), 'samples', 'pdfs'), join(dir, 'pdfs'), { recursive: true })
  const projectPath = join(dir, 'project.json')
  writeFileSync(projectPath, readFileSync(join(process.cwd(), 'samples', 'project.example.json'), 'utf-8'))
  return { dir, projectPath }
}

/**
 * Open `projectPath` through the real "Open" menu. Playwright cannot drive
 * the native file picker, so `dialog.showOpenDialog` is stubbed in the main
 * process (via `electronApp.evaluate`, which runs there) to return it
 * directly — everything downstream (`project:open`'s IPC handler, the
 * renderer's `loadFromText`) is exercised for real.
 */
async function openProjectViaUi(app: ElectronApplication, page: Page, projectPath: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog
  }, projectPath)
  await page.locator('header.toolbar').getByRole('button', { name: 'Open ▾' }).click()
  await page.getByRole('menuitem', { name: 'Open file…' }).click()
  // project.example.json has 2 reviewers: the reviewer-seat prompt blocks
  // everything else until a seat is picked (see ReviewerPrompt.tsx) — REQ-LLM-90
  // also requires a numbered seat (not Consolidation) for the AI dialog to open.
  await page.getByRole('button', { name: 'Reviewer 1' }).click()
}

/**
 * Add the mock server as an openai-compatible, keyless LLM target through the
 * real settings UI, exercising the real `llm:saveConfig` save path — then
 * explicitly pick it as the annotator. Each test runs on a throwaway
 * `--user-data-dir`, so no earlier target can be preselected.
 */
async function addMockLlmTarget(page: Page, port: number): Promise<string> {
  const name = `Mock LLM ${port}`
  // Structural selectors, not exact copy: the setup/gear button's wording is
  // in flux (AiDialog.tsx is mid-edit elsewhere in this codebase right now),
  // but `.ai-empty-configs`'s one button and the gear icon's `.icon-btn` are
  // stable regardless of what the button currently says.
  const setupButton = page.locator('.ai-empty-configs button')
  if (await setupButton.count()) {
    await setupButton.click()
  } else {
    await page.locator('.ai-dialog .icon-btn', { hasText: '⚙' }).click()
  }

  const settings = page.locator('.llm-settings')
  await settings.locator('.llm-add button').click()
  await settings.locator('#llm-name').fill(name)
  await settings.locator('#llm-provider').selectOption('openai-compatible')
  await settings.locator('#llm-url').fill(`http://127.0.0.1:${port}`)
  await settings.locator('#llm-model').fill('mock-model')
  await settings.locator('#llm-nokey').check()
  await settings.getByRole('button', { name: 'Save' }).click()

  // Back to the AI dialog's setup screen — then make sure our target (not
  // whatever was last selected on this machine) is the one picked.
  await page.keyboard.press('Escape')
  const sendTo = page.locator('.ai-target-row input').first()
  await sendTo.click()
  await sendTo.fill(name)
  await page.getByRole('option', { name: new RegExp(`^${name} `) }).first().click()
  return name
}

test.describe('AI-assisted annotation', () => {
  let mock: { server: http.Server; port: number }

  test.beforeAll(async () => {
    mock = await startMockLlmServer()
  })

  test.afterAll(async () => {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  })

  test('prompt mode: propose, review, apply and undo one field', async () => {
    const { dir, projectPath } = copyProject()
    // Throwaway profile: saved models and dialog choices must never leak into a real one.
    const userData = mkdtempSync(join(tmpdir(), 'sailor-e2e-userdata-'))
    const app = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${userData}`] })
    try {
      const page = await app.firstWindow()
      await openProjectViaUi(app, page, projectPath)

      await page.locator('[data-paper-id="paper-a"]').click()
      await page.getByRole('button', { name: '✦ AI' }).click()
      await addMockLlmTarget(page, mock.port)

      // Prompt is the default mode on a fresh target/run — click it anyway so
      // this test doesn't depend on whatever mode a previous run left selected.
      await page.getByRole('radio', { name: 'Prompt' }).click()
      await page.getByRole('button', { name: 'Start' }).click()

      const applyButton = page.getByRole('button', { name: /^Apply \d+$/ })
      await expect(applyButton).toBeVisible({ timeout: 30_000 })

      await expect(page.getByRole('row', { name: /Study Type/ })).toBeVisible()
      await expect(page.getByRole('row', { name: /Year/ })).toBeVisible()
      await expect(page.getByRole('checkbox', { name: 'Apply the proposal for Study Type' })).toBeChecked()

      await applyButton.click()
      await expect(page.locator('.ai-dialog')).toContainText('Filled 2 fields in 1 paper')
      // `.ai-foot`, not the whole dialog: the modal-head's × icon button also
      // has `aria-label="Close"`, so `.ai-dialog`-scoped alone is ambiguous.
      await page.locator('.ai-dialog .ai-foot').getByRole('button', { name: 'Close' }).click()

      // Attribute selector, not `input[aria-label=...]`: a plain string field
      // (Study Type) renders as a `<textarea>` (Field.tsx's `StringField`, for
      // its auto-expand behavior), while a number field (Year) is an `<input>`.
      await expect(page.locator('[aria-label="Study Type"]')).toHaveValue(STUDY_TYPE_VALUE)
      await expect(page.locator('[aria-label="Year"]')).toHaveValue(String(YEAR_VALUE))

      // `page.keyboard.press('ControlOrMeta+z')` reaches the page's own DOM via
      // CDP but does not fire Electron's native Menu accelerator here — that
      // dispatch goes through the OS window manager, which this environment's
      // window has no real focus in (confirmed: explicit `BrowserWindow#show`/
      // `#focus` plus a real click into the page first still didn't make the
      // keypress land as the accelerator). The accelerator's own handler is one
      // line (`electron/main.ts`'s Undo menu item: `mainWindow?.webContents.send
      // ('app:undo')`), so sending that same IPC event exercises the identical
      // undo code path a real Ctrl+Z would, without depending on OS-level
      // keyboard focus this environment cannot provide.
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('app:undo')
      })
      await expect(page.locator('[aria-label="Study Type"]')).toHaveValue('')
      await expect(page.locator('[aria-label="Year"]')).toHaveValue('')
    } finally {
      await closeApp(app)
      rmSync(dir, { recursive: true, force: true })
      rmSync(userData, { recursive: true, force: true })
    }
  })

  test('agent mode: tool round-trip, judge verdict, apply', async () => {
    test.setTimeout(90_000)
    const { dir, projectPath } = copyProject()
    // Throwaway profile: saved models and dialog choices must never leak into a real one.
    const userData = mkdtempSync(join(tmpdir(), 'sailor-e2e-userdata-'))
    const app = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${userData}`] })
    try {
      const page = await app.firstWindow()
      await openProjectViaUi(app, page, projectPath)

      await page.locator('[data-paper-id="paper-a"]').click()
      await page.getByRole('button', { name: '✦ AI' }).click()
      await addMockLlmTarget(page, mock.port)

      await page.getByRole('radio', { name: 'Agent' }).click()
      await page.getByRole('button', { name: 'Start' }).click()

      const applyButton = page.getByRole('button', { name: /^Apply \d+$/ })
      await expect(applyButton).toBeVisible({ timeout: 60_000 })

      // Agent mode adds two columns prompt mode doesn't have.
      await expect(page.locator('.ai-table thead th', { hasText: 'Source' })).toBeVisible()
      await expect(page.locator('.ai-table thead th', { hasText: 'Check' })).toBeVisible()
      await expect(page.locator('.ai-judge-accept').first()).toHaveText('Accepted')

      await applyButton.click()
      await expect(page.locator('.ai-dialog')).toContainText('Filled 2 fields in 1 paper')
      await page.locator('.ai-dialog .ai-foot').getByRole('button', { name: 'Close' }).click()

      await expect(page.locator('[aria-label="Study Type"]')).toHaveValue(STUDY_TYPE_VALUE)
      await expect(page.locator('[aria-label="Year"]')).toHaveValue(String(YEAR_VALUE))
    } finally {
      await closeApp(app)
      rmSync(dir, { recursive: true, force: true })
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
