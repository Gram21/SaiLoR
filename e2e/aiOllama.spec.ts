import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { closeApp } from './helpers'

/**
 * Guided Ollama setup and prompt-mode run against a mock of Ollama's native
 * API (`/api/chat`, not `/v1/chat/completions`). The mock records every chat
 * request so specs can assert on what the app really sent (`num_ctx`,
 * `stream`, trimmed paper). Harness patterns follow aiAnnotate.spec.ts.
 */

const MODEL = 'qwen3.5:4b'
const ANSWER = JSON.stringify({
  fields: [
    { path: 'Study Type', value: 'RCT', evidence: 'Study Type: RCT', confidence: 0.9 },
    { path: 'Year', value: 2021, evidence: 'Year: 2021', confidence: 0.9 },
  ],
  skipped: [],
})

interface ChatBody {
  model: string
  stream?: boolean
  messages: { role: string; content: string }[]
  options?: { num_ctx?: number }
}

interface Mock {
  server: http.Server
  port: number
  chats: ChatBody[]
  paths: string[]
  /** Reports prompt_eval_count = num_ctx - 10 (a prompt the server silently cut). */
  truncate: boolean
}

function startMock(): Promise<Mock> {
  return new Promise((resolve) => {
    const mock = { chats: [], paths: [], truncate: false } as unknown as Mock
    mock.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const url = req.url ?? ''
        mock.paths.push(`${req.method} ${url}`)
        const send = (o: unknown, status = 200) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(o))
        }
        if (url === '/api/version') return send({ version: '0.12.0' })
        if (url === '/api/tags') {
          return send({
            models: [{ name: MODEL, model: MODEL, size: 3_400_000_000, details: { parameter_size: '4B', quantization_level: 'Q4_K_M' } }],
          })
        }
        if (url === '/api/show') {
          return send({
            capabilities: ['completion', 'tools', 'thinking'],
            model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 },
          })
        }
        if (url === '/api/ps') return send({ models: [] })
        if (url === '/api/chat') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as ChatBody
          mock.chats.push(body)
          const numCtx = body.options?.num_ctx ?? 4096
          return send({
            model: MODEL,
            message: { role: 'assistant', content: ANSWER },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: mock.truncate ? numCtx - 10 : 500,
            eval_count: 50,
          })
        }
        send({ error: 'not found' }, 404)
      })
    })
    mock.server.listen(0, '127.0.0.1', () => {
      mock.port = (mock.server.address() as AddressInfo).port
      resolve(mock)
    })
  })
}

async function withApp(fn: (app: ElectronApplication, page: Page) => Promise<void>, paperId = 'paper-a'): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sailor-e2e-ollama-'))
  cpSync(join(process.cwd(), 'samples', 'pdfs'), join(dir, 'pdfs'), { recursive: true })
  const projectPath = join(dir, 'project.json')
  writeFileSync(projectPath, readFileSync(join(process.cwd(), 'samples', 'project.example.json'), 'utf-8'))
  const userData = mkdtempSync(join(tmpdir(), 'sailor-e2e-userdata-'))
  const app = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${userData}`] })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog
    }, projectPath)
    await page.locator('header.toolbar').getByRole('button', { name: 'Open ▾' }).click()
    await page.getByRole('menuitem', { name: 'Open file…' }).click()
    await page.getByRole('button', { name: 'Reviewer 1' }).click()
    await page.locator(`[data-paper-id="${paperId}"]`).click()
    await page.getByRole('button', { name: '✦ AI' }).click()
    await fn(app, page)
  } finally {
    await closeApp(app)
    rmSync(dir, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  }
}

/** Guided setup in the settings dialog; `context: ''` clears the field. Back on the AI setup screen with the model picked. */
async function setupOllama(page: Page, port: number, context: string): Promise<void> {
  const setupButton = page.locator('.ai-empty-configs button')
  if (await setupButton.count()) await setupButton.click()
  else await page.locator('.ai-dialog .icon-btn', { hasText: '⚙' }).click()

  const settings = page.locator('.llm-settings')
  await settings.locator('.llm-add button').click()
  await settings.getByLabel('Provider').selectOption({ label: 'Local model — chat (Ollama, LM Studio, llama.cpp, vLLM)' })
  await settings.getByLabel('Server URL').fill(`http://127.0.0.1:${port}`)
  await settings.getByRole('button', { name: 'Check connection' }).click()
  const row = settings.getByRole('listitem', { name: MODEL })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Use' }).click()
  const ctx = settings.getByLabel('Context to use')
  await expect(ctx).toBeVisible()
  await ctx.fill(context)
  await settings.getByRole('button', { name: 'Save' }).click()

  await page.keyboard.press('Escape')
  const sendTo = page.locator('.ai-target-row input').first()
  await sendTo.click()
  await sendTo.fill(MODEL)
  await page.getByRole('option', { name: new RegExp(`^${MODEL.replace('.', '\\.')}`) }).first().click()
  await page.getByRole('radio', { name: 'Prompt' }).click()
}

test.describe('AI with a local Ollama model', () => {
  let mock: Mock

  test.beforeAll(async () => {
    mock = await startMock()
  })
  test.afterAll(async () => {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  })
  test.beforeEach(() => {
    mock.chats.length = 0
    mock.paths.length = 0
    mock.truncate = false
  })

  test('guided setup, run on native /api/chat, apply', async () => {
    await withApp(async (_app, page) => {
      await setupOllama(page, mock.port, '8192')
      await page.getByRole('button', { name: 'Start' }).click()

      const apply = page.getByRole('button', { name: /^Apply \d+$/ })
      await expect(apply).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('row', { name: /Study Type/ })).toBeVisible()
      await expect(page.getByRole('row', { name: /Year/ })).toBeVisible()
      await apply.click()
      await expect(page.locator('.ai-dialog')).toContainText('Filled 2 fields in 1 paper')
      await page.locator('.ai-dialog .ai-foot').getByRole('button', { name: 'Close' }).click()
      await expect(page.locator('[aria-label="Study Type"]')).toHaveValue('RCT')
      await expect(page.locator('[aria-label="Year"]')).toHaveValue('2021')

      expect(mock.paths.some((p) => p.includes('/v1/'))).toBe(false)
      expect(mock.chats.length).toBeGreaterThan(0)
      const last = mock.chats[mock.chats.length - 1]
      expect(last.model).toBe(MODEL)
      expect(last.options?.num_ctx).toBe(8192)
      expect(last.stream).toBe(false)
      expect(last.messages[0].role).toBe('system')
      expect(last.messages[0].content.length).toBeGreaterThan(0)
    })
  })

  test('paper is trimmed to fit a small context', async () => {
    await withApp(async (_app, page) => {
      // The reply reserve (4096) plus prompt leave little room in 8192; the long sample paper cannot fit.
      await setupOllama(page, mock.port, '8192')
      await page.getByRole('button', { name: 'Start' }).click()
      await expect(page.getByRole('button', { name: /^Apply \d+$/ })).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('.ai-dialog')).toContainText(/Paper trimmed to fit .* input window/)

      const user = mock.chats[mock.chats.length - 1].messages.find((m) => m.role === 'user')!
      expect(user.content).toMatch(/omitted/i)
      expect(user.content.length).toBeLessThan(8192 * 3.2)
    }, 'KeimKaplan2026_ICSEBoF')
  })

  test('silently truncated prompt is rejected', async () => {
    mock.truncate = true
    await withApp(async (_app, page) => {
      await setupOllama(page, mock.port, '8192')
      await page.getByRole('button', { name: 'Start' }).click()
      await expect(page.locator('.ai-dialog')).toContainText('cut off the start of the prompt', { timeout: 30_000 })
      await expect(page.getByRole('button', { name: /^Apply \d+$/ })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.locator('[aria-label="Study Type"]')).toHaveValue('')
      await expect(page.locator('[aria-label="Year"]')).toHaveValue('')
    })
  })

  test('missing context blocks Start', async () => {
    await withApp(async (_app, page) => {
      await setupOllama(page, mock.port, '')
      await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled()
      await expect(page.locator('.ai-dialog')).toContainText('Context to use')
    })
  })
})
