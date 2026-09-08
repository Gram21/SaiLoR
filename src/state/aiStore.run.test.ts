import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse } from '../llm/types'
import type { PdfText } from '../model/pdfText'

/**
 * `run()` is the main annotation call: extract (or attach) the paper, send it,
 * and turn the reply into review rows. This file pins the behavioral contracts
 * that live entirely inside that one function and are otherwise untested:
 *
 *   - it delivers the paper as text or as a native PDF depending on the
 *     target's `attach` setting and the provider's own PDF support,
 *   - it refuses to send an image-only PDF's (empty) extracted text,
 *   - it reports elapsed seconds while the call is in flight,
 *   - it tells a reasoning-budget truncation apart from a genuinely empty reply,
 *   - and a run that resolves after a newer one has started is discarded.
 */

let calls: LlmHttpRequest[] = []
let deferreds: Array<{ resolve: (r: LlmHttpResponse) => void }> = []
let nextPdfText: PdfText = { text: 'the extracted paper text', pages: 1, empty: false }

vi.mock('../model/pdfText', () => ({
  extractPdfText: vi.fn(async () => nextPdfText),
}))

const mockPlatform = {
  kind: 'browser' as const,
  getOsInfo: () => null,
  getRecents: () => [] as RecentEntry[],
  rememberProject: () => {},
  forgetRecent: () => [] as RecentEntry[],
  checkRecents: async (entries: RecentEntry[]) => entries,
  openProject: async () => null,
  openRecent: async () => null,
  saveProject: async (_text: string, handle: SaveHandle) => handle,
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: 'blob://paper' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async (config: LlmConfig) => [{ ...config, hasKey: true }],
  deleteLlmConfig: async () => [],
  callLlm: async (request: LlmHttpRequest) => {
    calls.push(request)
    return new Promise<LlmHttpResponse>((resolve) => {
      deferreds.push({ resolve })
    })
  },
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')
const { useAiStore } = await import('./aiStore')

// Minimal schema: one plain string field is enough to carry a distinguishing
// suggestion through the whole pipeline.
const PROJECT = JSON.stringify({
  version: 1,
  title: 'AI run',
  config: { schema: [{ name: 'Summary', type: 'string' }] },
  papers: [{ id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} }],
})

function cfg(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: 'c1',
    name: 'test',
    provider: 'anthropic',
    baseUrl: '',
    model: 'claude-x',
    attach: 'text',
    hasKey: true,
    ...over,
  }
}

const anthropicOk = (fields: unknown[]) => ({
  ok: true,
  status: 200,
  body: JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify({ fields, skipped: [], rejected: [] }) }],
  }),
})

const st = () => useStore.getState()
const ai = () => useAiStore.getState()

/** Flush the microtask queue enough times for a handful of chained real awaits
 *  (getPdfSource → fetch → arrayBuffer → extractPdfText → callLlm) to settle,
 *  without waiting on any real timer. */
async function flush(times = 30) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

beforeEach(() => {
  calls = []
  deferreds = []
  nextPdfText = { text: 'the extracted paper text', pages: 1, empty: false }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
  )
  st().loadFromText(PROJECT, null, 'test.json')
  st().selectPaper('p1')
  useAiStore.setState({
    configs: [],
    selectedId: null,
    phase: 'setup',
    error: null,
    elapsed: 0,
    targets: [],
    answer: null,
    rows: [],
    scanned: false,
  })
})

describe('run: delivering the paper as text or PDF', () => {
  it('sends extracted text when the target is set to text delivery', async () => {
    const c = cfg({ attach: 'text', provider: 'anthropic' })
    useAiStore.setState({ configs: [c], selectedId: c.id })

    const runPromise = ai().run()
    await flush()
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].body!)
    expect(body.messages[0].content[0].type).toBe('text')
    expect(body.messages[0].content[0].text).toContain('the extracted paper text')

    deferreds[0].resolve(anthropicOk([]))
    await runPromise
    expect(ai().phase).toBe('review')
  })

  it('attaches the PDF natively when the target is set to PDF delivery on a provider that supports it', async () => {
    const c = cfg({ attach: 'pdf', provider: 'anthropic' })
    useAiStore.setState({ configs: [c], selectedId: c.id })

    const runPromise = ai().run()
    await flush()
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].body!)
    expect(body.messages[0].content[0].type).toBe('document')

    deferreds[0].resolve(anthropicOk([]))
    await runPromise
    expect(ai().phase).toBe('review')
  })

  it('falls back to extracted text when the provider cannot accept a PDF at all', async () => {
    // Groq has no file/vision input (see providers.ts) — a target configured
    // for "send the PDF itself" must still fall back to text on it.
    const c = cfg({ attach: 'pdf', provider: 'groq', model: 'llama' })
    useAiStore.setState({ configs: [c], selectedId: c.id })

    const runPromise = ai().run()
    await flush()
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].body!)
    expect(body.messages[1].content).toContain('the extracted paper text')

    deferreds[0].resolve({
      ok: true,
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ fields: [], skipped: [], rejected: [] }) } }],
      }),
    })
    await runPromise
    expect(ai().phase).toBe('review')
  })
})

describe('run: refusing an image-only PDF on the text path', () => {
  it('errors out instead of sending empty extracted text, and never calls the model', async () => {
    nextPdfText = { text: '', pages: 3, empty: true }
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id })

    await ai().run()

    expect(calls).toHaveLength(0)
    expect(ai().phase).toBe('error')
    expect(ai().scanned).toBe(true)
    expect(ai().error).toMatch(/scan of a printed/)
  })
})

describe('run: distinguishing truncation from a genuinely empty answer', () => {
  it('reports the reasoning-budget message when the reply was cut off with no text', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id })

    const runPromise = ai().run()
    await flush()
    deferreds[0].resolve({
      ok: true,
      status: 200,
      body: JSON.stringify({ content: [], stop_reason: 'max_tokens' }),
    })
    await runPromise

    expect(ai().phase).toBe('error')
    expect(ai().error).toMatch(/whole reply budget on internal/)
  })

  it('treats a plain empty reply (no truncation flag) as zero suggestions, not an error', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id })

    const runPromise = ai().run()
    await flush()
    deferreds[0].resolve({ ok: true, status: 200, body: JSON.stringify({ content: [] }) })
    await runPromise

    expect(ai().phase).toBe('review')
    expect(ai().error).toBeNull()
    expect(ai().answer).toEqual({ fields: [], skipped: [], rejected: [] })
  })
})

describe('run: elapsed seconds tick while a call is in flight', () => {
  it('advances elapsed once a second and stops once the run settles', async () => {
    vi.useFakeTimers()
    try {
      const c = cfg({ attach: 'text' })
      useAiStore.setState({ configs: [c], selectedId: c.id })

      const runPromise = ai().run()
      await flush()
      expect(ai().phase).toBe('calling')
      expect(ai().elapsed).toBe(0)

      await vi.advanceTimersByTimeAsync(3000)
      expect(ai().elapsed).toBe(3)

      deferreds[0].resolve(anthropicOk([]))
      await runPromise
      expect(ai().phase).toBe('review')

      const elapsedAfterSettling = ai().elapsed
      await vi.advanceTimersByTimeAsync(2000)
      // The ticker is stopped once the run settles, so elapsed does not keep climbing.
      expect(ai().elapsed).toBe(elapsedAfterSettling)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('run: a superseded run is discarded', () => {
  it('never publishes a reply for a run that finishes after a newer one started', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id })

    const first = ai().run()
    await flush()
    expect(calls).toHaveLength(1)

    // The reviewer starts a second run before the first has answered.
    const second = ai().run()
    await flush()
    expect(calls).toHaveLength(2)

    deferreds[1].resolve(anthropicOk([{ path: 'Summary', value: 'from run two', evidence: 'e', confidence: 0.9 }]))
    await second
    expect(ai().phase).toBe('review')
    expect(ai().answer?.fields[0]?.value).toBe('from run two')

    // The stale first run now resolves. Its own answer must never reach the
    // review rows the reviewer is looking at — see the `runFor` comment and the
    // `if (controller !== myController) return` guard in aiStore.ts.
    deferreds[0].resolve(anthropicOk([{ path: 'Summary', value: 'from run one', evidence: 'e', confidence: 0.9 }]))
    await first

    expect(ai().answer?.fields[0]?.value).toBe('from run two')
    expect(ai().rows[0]?.suggestion.value).toBe('from run two')
    // The stale run's own phase transitions ('calling'/'parsing') must also be
    // silenced, not just its answer — otherwise it visibly knocks the UI back
    // over the newer run's 'review' after the reviewer is already looking at it.
    expect(ai().phase).toBe('review')
  })
})
