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
 * Classify mode (REQ-LLM-550: one `/v1/systemone` request per paper, eligible
 * fields only, confidence-threshold unticking) and the cross-check role
 * (REQ-LLM-560: a System One second opinion on a prompt-mode run's proposed
 * values, disagreement unticking, and a failure that never fails the paper).
 */

let nextPdfText: PdfText = { text: 'paper text', pages: 1, empty: false }
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
  callLlm: vi.fn<(request: LlmHttpRequest, signal?: AbortSignal) => Promise<LlmHttpResponse>>(),
  fetchWeb: async () => ({ ok: false, status: 0, url: '', contentType: '', body: '', truncated: false }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')
const { useAiStore } = await import('./aiStore')

const PROJECT = JSON.stringify({
  version: 1,
  title: 'Classify',
  config: {
    schema: [
      { name: 'Relevant', type: 'boolean' },
      { name: 'Notes', type: 'string' },
    ],
  },
  papers: [{ id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} }],
})

function chatCfg(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: 'chat1',
    name: 'annotator',
    provider: 'anthropic',
    baseUrl: '',
    model: 'claude-x',
    attach: 'text',
    hasKey: true,
    ...over,
  }
}

const schema = resolveSchema([
  { name: 'Relevant', type: 'boolean' },
  { name: 'Notes', type: 'string' },
])

function target(name: string): FieldTarget {
  const def = schema.find((d) => d.name === name)!
  return { path: name, def, value: undefined }
}

const TARGETS: FieldTarget[] = [target('Relevant'), target('Notes')]

function s1Cfg(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: 's1',
    name: 'System One',
    provider: 'systemone',
    baseUrl: 'https://api.typesafe.ai',
    model: 'jev-latest',
    attach: 'text',
    hasKey: true,
    ...over,
  }
}

const st = () => useStore.getState()
const ai = () => useAiStore.getState()

function s1Response(noul: number): LlmHttpResponse {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      answers: { q0: { noul } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }),
  }
}

function chatOk(fields: unknown[]): LlmHttpResponse {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ fields, skipped: [], rejected: [] }) }],
    }),
  }
}

beforeEach(() => {
  mockPlatform.callLlm.mockReset()
  nextPdfText = { text: 'paper text', pages: 1, empty: false }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
  )
  localStorage.clear()
  st().loadFromText(PROJECT, null, 'test.json')
  st().selectPaper('p1')
  useAiStore.setState({
    configs: [],
    selectedId: null,
    judgeSelectedId: null,
    crossCheckId: null,
    confidenceThreshold: 0.8,
    spendCap: null,
    spentSoFar: 0,
    spendCapHit: false,
    retryNotice: null,
    mode: 'classify',
    allPapers: false,
    phase: 'setup',
    error: null,
    elapsed: 0,
    targets: TARGETS,
    candidates: [],
    rows: [],
    notes: [],
    errors: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    runUsage: null,
    runJudge: null,
    roundsByPaper: {},
    fewShotByPaper: {},
    agentEvents: [],
    scanned: false,
  })
})

describe('classify mode', () => {
  it('sends one /v1/systemone request for the eligible field and reports the ineligible one as skipped', async () => {
    const config = s1Cfg()
    useAiStore.setState({ configs: [config], selectedId: config.id, mode: 'classify' })
    mockPlatform.callLlm.mockResolvedValueOnce(s1Response(0.9))

    await ai().run()

    expect(mockPlatform.callLlm).toHaveBeenCalledTimes(1)
    const req = mockPlatform.callLlm.mock.calls[0][0]
    expect(req.url).toContain('/v1/systemone')

    expect(ai().rows).toHaveLength(1)
    expect(ai().rows[0].suggestion.path).toBe('Relevant')
    expect(ai().rows[0].suggestion.value).toBe(true)
    expect(ai().rows[0].suggestion.source).toBe('system-one')
    expect(ai().notes[0].skipped).toContainEqual({ path: 'Notes', reason: 'not handled in Classify mode' })
  })

  it('ticks a row at or above the confidence threshold, and unticks one below it', async () => {
    const config = s1Cfg()
    useAiStore.setState({ configs: [config], selectedId: config.id, mode: 'classify', confidenceThreshold: 0.8 })
    mockPlatform.callLlm.mockResolvedValueOnce(s1Response(0.9))
    await ai().run()
    expect(ai().rows[0].checked).toBe(true)

    mockPlatform.callLlm.mockReset()
    mockPlatform.callLlm.mockResolvedValueOnce(s1Response(0.6)) // confidence = max(0.6, 0.4) = 0.6 < 0.8
    useAiStore.setState({ phase: 'setup', rows: [], notes: [] })
    await ai().run()
    expect(ai().rows[0].checked).toBe(false)
  })
})

describe('cross-check role', () => {
  beforeEach(() => {
    useAiStore.setState({ mode: 'prompt' })
  })

  it('flags a confident disagreement and unticks it, while agreement stays ticked', async () => {
    const annotator = chatCfg()
    const crossCheck = s1Cfg()
    useAiStore.setState({
      configs: [annotator, crossCheck],
      selectedId: annotator.id,
      crossCheckId: crossCheck.id,
      confidenceThreshold: 0.8,
    })
    mockPlatform.callLlm.mockImplementation(async (req: LlmHttpRequest) => {
      if (req.url.includes('/v1/systemone')) return s1Response(0.1) // confident "false" — disagrees with `true`
      return chatOk([{ path: 'Relevant', value: true, evidence: 'quote', confidence: 0.7 }])
    })

    await ai().run()

    expect(ai().rows).toHaveLength(1)
    const row = ai().rows[0]
    expect(row.crossCheck).toEqual({ agrees: false, s1Value: false, p: 0.9 })
    expect(row.checked).toBe(false)
  })

  it('leaves an agreeing row ticked', async () => {
    const annotator = chatCfg()
    const crossCheck = s1Cfg()
    useAiStore.setState({
      configs: [annotator, crossCheck],
      selectedId: annotator.id,
      crossCheckId: crossCheck.id,
      confidenceThreshold: 0.8,
    })
    mockPlatform.callLlm.mockImplementation(async (req: LlmHttpRequest) => {
      if (req.url.includes('/v1/systemone')) return s1Response(0.95)
      return chatOk([{ path: 'Relevant', value: true, evidence: 'quote', confidence: 0.7 }])
    })

    await ai().run()

    expect(ai().rows[0].crossCheck?.agrees).toBe(true)
    expect(ai().rows[0].checked).toBe(true)
  })

  it('records a note and still applies the paper\'s rows when the cross-check call fails', async () => {
    const annotator = chatCfg()
    const crossCheck = s1Cfg()
    useAiStore.setState({
      configs: [annotator, crossCheck],
      selectedId: annotator.id,
      crossCheckId: crossCheck.id,
    })
    mockPlatform.callLlm.mockImplementation(async (req: LlmHttpRequest) => {
      if (req.url.includes('/v1/systemone')) return { ok: false, status: 400, body: 'boom' }
      return chatOk([{ path: 'Relevant', value: true, evidence: 'quote', confidence: 0.7 }])
    })

    await ai().run()

    expect(ai().phase).toBe('review')
    expect(ai().rows).toHaveLength(1)
    expect(ai().rows[0].checked).toBe(true) // prompt-mode default, cross-check failure doesn't touch it
    expect(ai().notes[0].skipped.some((s) => s.path === '(cross-check)')).toBe(true)
  })

  it('is never consulted in classify mode', async () => {
    const s1Annotator = s1Cfg()
    const crossCheck = s1Cfg({ id: 's1-other' })
    useAiStore.setState({
      configs: [s1Annotator, crossCheck],
      selectedId: s1Annotator.id,
      crossCheckId: crossCheck.id,
      mode: 'classify',
    })
    mockPlatform.callLlm.mockResolvedValueOnce(s1Response(0.9))

    await ai().run()

    expect(mockPlatform.callLlm).toHaveBeenCalledTimes(1) // only the annotator's own call
  })
})
