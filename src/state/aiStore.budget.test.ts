import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse } from '../llm/types'
import type { PdfText } from '../model/pdfText'
import { resolveSchema } from '../model/schema'
import type { FieldTarget } from '../llm/fields'

if (typeof globalThis.localStorage === 'undefined') {
  const backing = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
    },
    configurable: true,
  })
}

/**
 * Input-window budgeting (REQ-LLM-740), never using truncated input
 * (REQ-LLM-741), reporting what a model could not handle (REQ-LLM-742) and the
 * Agent-mode context floor (REQ-LLM-743), at the store level.
 */

let nextPdfText: PdfText = { text: 'paper text', pages: 1, empty: false }
vi.mock('../model/pdfText', () => ({
  extractPdfText: vi.fn(async () => nextPdfText),
}))

const localRuntime = {
  status: vi.fn(async () => [] as { catalogId: string; state: string }[]),
  start: vi.fn(async (_id: string) => ({})),
}

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
  callLlm: vi.fn<(request: LlmHttpRequest, signal?: AbortSignal) => Promise<LlmHttpResponse>>(),
  fetchWeb: async () => ({ ok: false, status: 0, url: '', contentType: '', body: '', truncated: false }),
  localRuntime,
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')
const { useAiStore, startBlocker, agentContextReason, destinationNote, fitForChat } = await import('./aiStore')

const FIELDS = Array.from({ length: 14 }, (_, i) => ({
  name: `Field ${String(i).padStart(2, '0')}`,
  type: 'boolean',
  description: 'Does the study report this property of the evaluated approach in a clear way',
}))
const SCHEMA = [
  { name: 'Summary', type: 'string' },
  { name: 'Kind', type: 'string', options: Array.from({ length: 30 }, (_, i) => `Option ${i}`) },
  ...FIELDS,
]
const PROJECT = JSON.stringify({
  version: 1,
  title: 'Budget',
  config: { schema: SCHEMA },
  papers: [{ id: 'p1', title: 'Paper One', authors: [], abstract: 'An abstract.', pdf: 'p1.pdf', annotations: {} }],
})

const chatCfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  id: 'c1', name: 'annotator', provider: 'anthropic', baseUrl: '', model: 'claude-x', attach: 'text', hasKey: true, ...over,
})
const s1Cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  id: 's1', name: 'S1', provider: 'systemone', baseUrl: 'http://localhost:8080', model: 'laya', attach: 'text', hasKey: true, ...over,
})

const st = () => useStore.getState()
const ai = () => useAiStore.getState()

const pagedText = (pages: number) =>
  Array.from({ length: pages }, (_, i) => `[page ${i + 1}]\n${'lorem ipsum '.repeat(250)}`).join('\n\n')

const chatOk = (obj: unknown = { fields: [], skipped: [] }): LlmHttpResponse => ({
  ok: true,
  status: 200,
  body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 10, output_tokens: 5 } }),
})

/** Answers every asked question with a confident yes. */
const s1Echo = async (req: LlmHttpRequest): Promise<LlmHttpResponse> => {
  const ids = Object.keys(JSON.parse(req.body!).questions)
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      answers: Object.fromEntries(ids.map((id) => [id, { noul: 0.95 }])),
      usage: { input_tokens: 7, output_tokens: 2 },
    }),
  }
}

const schema = resolveSchema(SCHEMA as never)
const target = (name: string): FieldTarget => ({ path: name, def: schema.find((d) => d.name === name)!, value: undefined })
const ALL_TARGETS = SCHEMA.map((f) => target(f.name))

const bodyOf = (i = 0) => JSON.parse(mockPlatform.callLlm.mock.calls[i][0].body!)
const userTextOf = (i = 0) => bodyOf(i).messages[0].content[0].text as string

beforeEach(() => {
  mockPlatform.callLlm.mockReset()
  localRuntime.status.mockClear()
  localRuntime.start.mockClear()
  nextPdfText = { text: pagedText(10), pages: 10, empty: false }
  vi.stubGlobal('fetch', vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })))
  localStorage.clear()
  st().loadFromText(PROJECT, null, 'test.json')
  st().selectPaper('p1')
  useAiStore.setState({
    configs: [], selectedId: null, judgeSelectedId: null, crossCheckId: null, confidenceThreshold: 0.8,
    spendCap: null, spentSoFar: 0, spendCapHit: false, retryNotice: null, mode: 'prompt', allPapers: false,
    recheck: false, fewShot: false, phase: 'setup', error: null, elapsed: 0, targets: ALL_TARGETS, candidates: [],
    rows: [], recheckRows: [], notes: [], errors: [], fitByPaper: {},
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 }, runUsage: null, runJudge: null,
    roundsByPaper: {}, fewShotByPaper: {}, agentEvents: [], scanned: false,
  })
})

describe('prompt mode fits the paper to the window', () => {
  it('sends everything when the window is unknown', async () => {
    const c = chatCfg()
    useAiStore.setState({ configs: [c], selectedId: c.id })
    mockPlatform.callLlm.mockResolvedValueOnce(chatOk())
    await ai().run()
    expect(userTextOf()).toContain('[page 10]')
    expect(ai().fitByPaper).toEqual({})
  })

  it('trims trailing pages, records the fit and notes it in the review', async () => {
    const c = chatCfg({ contextTokens: 9000 })
    useAiStore.setState({ configs: [c], selectedId: c.id })
    mockPlatform.callLlm.mockResolvedValueOnce(chatOk())
    await ai().run()
    const text = userTextOf()
    expect(text).toContain('[page 1]')
    expect(text).not.toContain('[page 10]')
    expect(ai().fitByPaper.p1).toMatchObject({ pagesTotal: 10, droppedReferences: false })
    expect(ai().fitByPaper.p1.pagesKept).toBeLessThan(10)
    expect(ai().notes[0].info?.[0]).toMatch(/^Paper trimmed to fit claude-x's input window: pages? 1(–\d+)? of 10 sent$/)
  })

  it('fails the paper when the fixed parts leave no room', async () => {
    const c = chatCfg({ contextTokens: 3000 })
    useAiStore.setState({ configs: [c], selectedId: c.id })
    await ai().run()
    expect(mockPlatform.callLlm).not.toHaveBeenCalled()
    expect(ai().phase).toBe('error')
    expect(ai().error).toMatch(/window \(3,000 tokens\) is too small for this schema\/prompt; raise the context or use fewer examples/)
  })

  it('budgets the re-check call too', async () => {
    const c = chatCfg({ contextTokens: 9000 })
    useAiStore.setState({ configs: [c], selectedId: c.id, recheck: true })
    st().setFieldValue([], 'Summary', 0, 'old')
    mockPlatform.callLlm.mockImplementation(async (req) =>
      req.body?.includes('Fields to check') ? chatOk({ checks: [] }) : chatOk(),
    )
    await ai().run()
    expect(mockPlatform.callLlm).toHaveBeenCalledTimes(2)
    for (const i of [0, 1]) expect(userTextOf(i)).not.toContain('[page 10]')
  })

  it('leaves PDF delivery alone', async () => {
    const c = chatCfg({ contextTokens: 3000, attach: 'pdf' })
    useAiStore.setState({ configs: [c], selectedId: c.id })
    mockPlatform.callLlm.mockResolvedValueOnce(chatOk())
    await ai().run()
    expect(ai().phase).toBe('review')
    expect(ai().fitByPaper).toEqual({})
  })
})

describe('Ollama', () => {
  const ollama = (over: Partial<LlmConfig> = {}) =>
    chatCfg({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3', noKey: true, hasKey: false, ...over })

  it('blocks Start without a context window', async () => {
    const c = ollama()
    expect(startBlocker('prompt', c)).toMatch(/Set 'Context to use'/)
    useAiStore.setState({ configs: [c], selectedId: c.id })
    await ai().run()
    expect(mockPlatform.callLlm).not.toHaveBeenCalled()
    expect(ai().error).toMatch(/Context to use/)
  })

  it('fails the paper and applies nothing when the server cut the prompt', async () => {
    const c = ollama({ contextTokens: 16384 })
    useAiStore.setState({ configs: [c], selectedId: c.id })
    mockPlatform.callLlm.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: JSON.stringify({
        message: { content: JSON.stringify({ fields: [{ path: 'Summary', value: 'x', evidence: 'x', confidence: 1 }], skipped: [] }) },
        done: true,
        prompt_eval_count: 16384,
        eval_count: 5,
      }),
    })
    await ai().run()
    expect(ai().rows).toEqual([])
    expect(ai().phase).toBe('error')
    expect(ai().error).toMatch(/Context to use/)
  })
})

describe('Agent mode needs a large window', () => {
  it('disables Agent for a known small window, for annotator and judge', () => {
    expect(agentContextReason({ contextTokens: 16000 })).toMatch(/at least 32k tokens/)
    expect(agentContextReason({ contextTokens: 32000 })).toBeNull()
    expect(agentContextReason({})).toBeNull()
    const big = chatCfg({ contextTokens: 128000 })
    expect(startBlocker('agent', chatCfg({ contextTokens: 8192 }))).toMatch(/at least 32k tokens/)
    expect(startBlocker('agent', big, chatCfg({ id: 'j', contextTokens: 8192 }))).toMatch(/judge model is too small/)
    expect(startBlocker('agent', big, chatCfg({ id: 'j' }))).toBeNull()
    expect(startBlocker('prompt', chatCfg({ contextTokens: 8192 }))).toBeNull()
  })

  it('refuses to run', async () => {
    const c = chatCfg({ contextTokens: 8192 })
    useAiStore.setState({ configs: [c], selectedId: c.id, mode: 'agent' })
    await ai().run()
    expect(ai().phase).toBe('error')
    expect(ai().error).toMatch(/at least 32k tokens/)
  })
})

describe('Classify with a small-window model', () => {
  beforeEach(() => {
    nextPdfText = { text: 'x'.repeat(8000), pages: 1, empty: false }
  })

  it('sends several requests, merges them and reports what it left to the reviewer', async () => {
    const c = s1Cfg()
    useAiStore.setState({ configs: [c], selectedId: c.id, mode: 'classify' })
    mockPlatform.callLlm.mockImplementation(s1Echo)
    await ai().run()

    const n = mockPlatform.callLlm.mock.calls.length
    expect(n).toBeGreaterThan(1)
    expect(ai().rows).toHaveLength(14)
    expect(ai().usage).toEqual({ calls: n, inputTokens: 7 * n, outputTokens: 2 * n })
    const info = ai().notes[0].info ?? []
    expect(info).toContain('left to you: Kind — too many options for laya: use an LLM')
    expect(info.some((m) => m.startsWith('laya saw title + abstract only — its input window is 512 tokens'))).toBe(true)
  })

  it('surfaces a config that cannot form a request', async () => {
    const c = s1Cfg({ systemOneFlavor: 'cloudflare', accountId: 'nope', model: 'clef' })
    useAiStore.setState({ configs: [c], selectedId: c.id, mode: 'classify' })
    await ai().run()
    expect(mockPlatform.callLlm).not.toHaveBeenCalled()
    expect(ai().error).toMatch(/Cloudflare account id/)
  })

  it('cross-check counts only the calls it made', async () => {
    const annotator = chatCfg()
    const s1 = s1Cfg()
    useAiStore.setState({ configs: [annotator, s1], selectedId: annotator.id, crossCheckId: s1.id, targets: [target('Field 00')] })
    mockPlatform.callLlm.mockImplementation(async (req) =>
      req.url.includes('/v1/systemone')
        ? s1Echo(req)
        : chatOk({ fields: [{ path: 'Field 00', value: true, evidence: 'lorem', confidence: 0.9 }], skipped: [] }),
    )
    await ai().run()
    expect(ai().usage.calls).toBe(2)
  })
})

describe('managed local models', () => {
  const managed = () => s1Cfg({ baseUrl: '', managed: { catalogId: 'laya-en-q8' }, noKey: true, hasKey: false })

  it('starts the model first, showing the starting phase', async () => {
    const c = managed()
    useAiStore.setState({ configs: [c], selectedId: c.id, mode: 'classify', targets: [target('Field 00')] })
    const phases: string[] = []
    const off = useAiStore.subscribe((s) => { if (phases.at(-1) !== s.phase) phases.push(s.phase) })
    mockPlatform.callLlm.mockImplementation(s1Echo)
    await ai().run()
    off()
    expect(localRuntime.start).toHaveBeenCalledWith('laya-en-q8')
    expect(phases.indexOf('starting')).toBeGreaterThan(-1)
    expect(phases.indexOf('starting')).toBeLessThan(phases.indexOf('calling'))
    expect(ai().rows).toHaveLength(1)
  })

  it('shows why the start failed', async () => {
    const c = managed()
    useAiStore.setState({ configs: [c], selectedId: c.id, mode: 'classify', targets: [target('Field 00')] })
    localRuntime.start.mockRejectedValueOnce(
      new Error("Error invoking remote method 'local:start': Error: No llama.cpp runtime is installed."),
    )
    await ai().run()
    expect(mockPlatform.callLlm).not.toHaveBeenCalled()
    expect(ai().error).toBe('Could not start laya: No llama.cpp runtime is installed.')
  })
})

describe('helpers', () => {
  it('fitForChat leaves an unknown window alone and describes nothing', () => {
    expect(fitForChat(chatCfg(), 'sys', 'text')).toEqual({ text: 'text' })
  })

  it('words the destination for local and remote models', () => {
    expect(destinationNote(chatCfg({ provider: 'ollama', baseUrl: 'http://localhost:11434' }))).toMatch(/runs on your machine/)
    expect(destinationNote(s1Cfg({ baseUrl: '', managed: { catalogId: 'laya-en-q8' } }))).toMatch(/runs on your machine/)
    expect(destinationNote(chatCfg({ provider: 'ollama', baseUrl: 'http://gpu.lab:11434' }))).toBe(
      'It leaves this machine and goes over the network to gpu.lab:11434.',
    )
    expect(destinationNote(s1Cfg({ baseUrl: '', systemOneFlavor: 'cloudflare' }))).toMatch(/api\.cloudflare\.com/)
  })
})
