import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse } from '../llm/types'
import type { AgentInput, AgentDeps, AgentResult } from '../llm/agent'

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
 * Opt-in re-check (REQ-LLM-660), agent-mode web search (REQ-LLM-670) and
 * schema feedback (REQ-LLM-680) at the store level: what is sent, what the
 * review starts with ticked, what Apply writes and what gets saved.
 */

vi.mock('../model/pdfText', () => ({
  extractPdfText: vi.fn(async () => ({ text: 'paper text', pages: 1, empty: false })),
}))

const runAgentMock = vi.fn<(input: AgentInput, deps: AgentDeps) => Promise<AgentResult>>()
vi.mock('../llm/agent', () => ({
  runAgent: (input: AgentInput, deps: AgentDeps) => runAgentMock(input, deps),
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
  listLlmConfigs: async () => [] as LlmConfig[],
  saveLlmConfig: async (config: LlmConfig) => [{ ...config, hasKey: true }],
  deleteLlmConfig: async () => [],
  callLlm: vi.fn<(request: LlmHttpRequest, signal?: AbortSignal) => Promise<LlmHttpResponse>>(),
  fetchWeb: async () => ({ ok: false, status: 0, url: '', contentType: '', body: '', truncated: false }),
  writeFeedback: vi.fn<(h: SaveHandle, name: string, content: string) => Promise<string | null>>(),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')
const { useAiStore, batchCandidates } = await import('./aiStore')

const cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  id: 'c1', name: 'test', provider: 'anthropic', baseUrl: '', model: 'claude-x', attach: 'text', hasKey: true, ...over,
})

const PROJECT = JSON.stringify({
  version: 1,
  title: 'Recheck',
  config: { schema: [{ name: 'Summary', type: 'string' }, { name: 'Year', type: 'number' }] },
  papers: [
    { id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} },
    { id: 'p2', title: 'Paper Two', authors: [], pdf: 'p2.pdf', annotations: {} },
  ],
})

const st = () => useStore.getState()
const ai = () => useAiStore.getState()

const reply = (obj: unknown) => ({
  ok: true,
  status: 200,
  body: JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }),
})
const FILL = { fields: [{ path: 'Year', value: 2020, evidence: 'SECRET QUOTE', confidence: 0.9 }], skipped: [] }
const CHECK = {
  checks: [
    { path: 'Summary', verdict: 'disagree', proposed: 'new', evidence: 'SECRET EVIDENCE', reason: 'r', confidence: 0.8 },
  ],
}

/** Routes by request: the re-check prompt is the only one with a "Fields to check" section. */
function mockLlm(fill: unknown = FILL, check: unknown = CHECK) {
  mockPlatform.callLlm.mockImplementation(async (req) => (req.body?.includes('Fields to check') ? reply(check) : reply(fill)))
}

const HANDLE: SaveHandle = { kind: 'electron', path: '/proj/review.json' }

beforeEach(() => {
  mockPlatform.callLlm.mockReset()
  mockPlatform.writeFeedback.mockReset()
  mockPlatform.writeFeedback.mockResolvedValue('annotations/feedback/run-x.json')
  runAgentMock.mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })))
  localStorage.clear()
  st().loadFromText(PROJECT, HANDLE, 'review.json')
  useStore.setState({ saveHandle: HANDLE })
  // p2 is fully answered and finished; p1 has Summary answered, Year empty.
  st().selectPaper('p2')
  st().setFieldValue([], 'Summary', 0, 'two')
  st().setFieldValue([], 'Year', 0, 2001)
  st().setAnnotationFinished(true)
  st().selectPaper('p1')
  st().setFieldValue([], 'Summary', 0, 'old')
  useAiStore.setState({
    configs: [cfg()], selectedId: 'c1', mode: 'prompt', allPapers: false, phase: 'setup', recheck: false,
    saveFeedback: true, webSearch: false, targets: [{ path: 'Year', def: { name: 'Year', type: 'number' } } as never],
    rows: [], recheckRows: [], remarks: [], notes: [], errors: [], feedbackResult: null, runUsage: null,
    webSearchesByPaper: {},
  })
})

describe('re-check option is opt-in', () => {
  it('is off after every dialog open and never stored', async () => {
    ai().setRecheck(true)
    expect(ai().recheck).toBe(true)
    await ai().openDialog()
    expect(ai().recheck).toBe(false)
    expect(localStorage.getItem('slr.llm.recheck')).toBeNull()
  })

  it('cannot be switched on outside prompt mode, and leaving prompt mode clears it', () => {
    ai().setMode('agent')
    ai().setRecheck(true)
    expect(ai().recheck).toBe(false)
    ai().setMode('prompt')
    ai().setRecheck(true)
    ai().setMode('classify')
    expect(ai().recheck).toBe(false)
  })

  it('adds finished / fully answered papers as candidates only when on', () => {
    expect(batchCandidates(st().project!, null).map((c) => c.id)).toEqual(['p1'])
    expect(batchCandidates(st().project!, null, true).map((c) => c.id)).toEqual(['p1', 'p2'])
  })
})

describe('re-check run and apply', () => {
  it('makes no re-check call and leaves answers alone when off', async () => {
    mockLlm()
    await ai().run()
    expect(mockPlatform.callLlm).toHaveBeenCalledTimes(1)
    expect(ai().recheckRows).toEqual([])
  })

  it('adds a second call per paper; disagreements start unticked', async () => {
    mockLlm()
    ai().setRecheck(true)
    await ai().run()
    expect(mockPlatform.callLlm).toHaveBeenCalledTimes(2)
    expect(ai().usage.calls).toBe(2)
    expect(ai().recheckRows).toHaveLength(1)
    expect(ai().recheckRows[0].checked).toBe(false)
    ai().apply()
    expect(st().project!.papers[0].annotations.Summary[0].value).toBe('old') // fill only
    expect(ai().applied).toMatchObject({ filled: 1 })
  })

  it('all-papers run re-checks a finished paper without filling it', async () => {
    mockLlm(FILL, { checks: [{ path: 'Summary', verdict: 'agree', reason: 'ok', confidence: 0.9 }] })
    ai().setRecheck(true)
    ai().setAllPapers(true)
    await ai().run()
    // p1: fill + re-check, p2 (finished, nothing empty): re-check only.
    expect(mockPlatform.callLlm).toHaveBeenCalledTimes(3)
    expect(ai().recheckRows.map((r) => r.paperId).sort()).toEqual(['p1', 'p2'])
    expect(ai().rows.map((r) => r.paperId)).toEqual(['p1'])
  })

  it('replaces a ticked disagreement in the same single undo step and records it', async () => {
    mockLlm()
    ai().setRecheck(true)
    await ai().run()
    ai().toggleRecheckRow(0, true)
    ai().apply()
    const paper = () => st().project!.papers[0]
    expect(paper().annotations.Summary[0].value).toBe('new')
    expect(paper().annotations.Year[0].value).toBe(2020)
    expect(ai().applied).toMatchObject({ filled: 2, replaced: 1 })
    expect(paper().aiUsage).toHaveLength(1)
    expect(paper().aiUsage[0].rechecked).toBe(1)
    st().undo()
    expect(paper().annotations.Summary[0].value).toBe('old')
    expect(paper().annotations.Year?.[0]?.value ?? null).toBeNull()
  })

  it('skips a replacement whose field the human changed meanwhile', async () => {
    mockLlm()
    ai().setRecheck(true)
    await ai().run()
    ai().toggleRecheckRow(0, true)
    st().setFieldValue([], 'Summary', 0, 'human edit')
    ai().apply()
    expect(st().project!.papers[0].annotations.Summary[0].value).toBe('human edit')
    expect(ai().applied?.replaced).toBeUndefined()
    expect(st().project!.papers[0].aiUsage[0].rechecked).toBeUndefined()
  })

  it('agree and unsure outcomes are not actionable', async () => {
    mockLlm(FILL, { checks: [{ path: 'Summary', verdict: 'agree', reason: 'ok', confidence: 0.9 }] })
    ai().setRecheck(true)
    await ai().run()
    ai().toggleRecheckRow(0, true)
    expect(ai().recheckRows[0].checked).toBe(false)
  })
})

describe('web search option (agent mode)', () => {
  const agentResult = (fields: object[], webSearches = 2): AgentResult => ({
    answer: { fields: fields as never, skipped: [], rejected: [] },
    rounds: 1,
    usage: { inputTokens: 5, outputTokens: 5, calls: 1, webSearches },
    judgeUsage: { inputTokens: 0, outputTokens: 0, calls: 0 },
    log: [],
  })

  it('passes the flag to runAgent only for a supporting provider', async () => {
    ai().setMode('agent')
    ai().setWebSearch(true)
    expect(localStorage.getItem('slr.llm.websearch')).toBe('true')
    runAgentMock.mockResolvedValue(agentResult([]))
    await ai().run()
    expect(runAgentMock.mock.calls[0][0].webSearch).toBe(true)

    useAiStore.setState({ configs: [cfg({ provider: 'openai' })] })
    await ai().run()
    expect(runAgentMock.mock.calls[1][0].webSearch).toBe(false)
  })

  it('starts web-unverified rows unticked (flagged) and records the search count', async () => {
    ai().setMode('agent')
    ai().setWebSearch(true)
    runAgentMock.mockResolvedValue(
      agentResult([
        { path: 'Year', value: 2020, evidence: 'q', confidence: 0.9, source: 'https://x.org', webUnverified: true,
          judge: { verdict: 'accept', feedback: '' } },
      ]),
    )
    await ai().run()
    expect(ai().rows[0].checked).toBe(false)
    expect(ai().rows[0].flagged).toBe(true)
    ai().setAllRows(true)
    ai().apply()
    expect(st().project!.papers[0].aiUsage[0].webSearches).toBe(2)
  })
})

describe('schema feedback', () => {
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  const written = () => JSON.parse(mockPlatform.writeFeedback.mock.calls[0][2])

  async function reviewWithUntickedRow() {
    mockLlm({ ...FILL, schema_remarks: [{ path: 'Year', issue: 'Which year?', suggestion: 'say publication year' }] }, CHECK)
    await ai().run()
  }

  it('is written once on apply, not again on close', async () => {
    await reviewWithUntickedRow()
    ai().apply()
    await flush()
    ai().closeDialog()
    await flush()
    expect(mockPlatform.writeFeedback).toHaveBeenCalledTimes(1)
    expect(ai().feedbackResult).toEqual({ path: 'annotations/feedback/run-x.json' })
  })

  it('is written once on discard, with the proposals as unticked', async () => {
    useAiStore.setState({ open: true })
    await reviewWithUntickedRow()
    ai().discardBatch()
    await flush()
    ai().closeDialog()
    await flush()
    expect(mockPlatform.writeFeedback).toHaveBeenCalledTimes(1)
    const fb = written()
    expect(fb.fields.find((f: { path: string }) => f.path === 'Year')).toMatchObject({ unticked: 1, applied: 0 })
  })

  it('holds no evidence quotes or paper text, and carries edited values', async () => {
    mockLlm({ ...FILL, schema_remarks: [{ path: 'Year', issue: 'Which year?' }] })
    await ai().run()
    expect(ai().editRow(0, 2019)).toBeNull()
    ai().apply()
    await flush()
    const raw = mockPlatform.writeFeedback.mock.calls[0][2]
    expect(raw).not.toContain('SECRET')
    expect(raw).not.toContain('paper text')
    expect(written().fields.find((f: { path: string }) => f.path === 'Year').edits).toEqual([{ ai: '2020', final: '2019' }])
    expect(mockPlatform.writeFeedback.mock.calls[0][1]).toMatch(/^run-.*\.json$/)
  })

  it('is skipped when the option is off, nothing is worth saving, or the platform returns null', async () => {
    mockLlm() // clean apply, no remarks: nothing worth saving
    await ai().run()
    ai().apply()
    await flush()
    expect(mockPlatform.writeFeedback).not.toHaveBeenCalled()

    useAiStore.setState({ saveFeedback: false })
    await reviewWithUntickedRow()
    ai().apply()
    await flush()
    expect(mockPlatform.writeFeedback).not.toHaveBeenCalled()

    useAiStore.setState({ saveFeedback: true })
    mockPlatform.writeFeedback.mockResolvedValue(null)
    await reviewWithUntickedRow()
    ai().apply()
    await flush()
    expect(mockPlatform.writeFeedback).toHaveBeenCalledTimes(1)
    expect(ai().feedbackResult).toBeNull()
  })

  it('never blocks apply and leaves the project clean-state flag alone', async () => {
    mockPlatform.writeFeedback.mockRejectedValue(new Error('disk full'))
    await reviewWithUntickedRow()
    ai().apply()
    expect(ai().phase).toBe('applied')
    const dirtyAfterApply = st().dirty
    await flush()
    expect(ai().feedbackResult).toEqual({ error: 'disk full' })
    expect(st().dirty).toBe(dirtyAfterApply)
    expect(st().project!.papers[0].annotations.Year[0].value).toBe(2020)
  })
})
