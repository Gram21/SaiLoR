import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse } from '../llm/types'
import type { PdfText } from '../model/pdfText'
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
 * Few-shot examples from finished papers (REQ-LLM-450): which papers count as
 * source candidates (Consolidation first in a multi-reviewer project, else the
 * current human seat; never the AI's own seat; never the paper being
 * annotated), that they reach the prompt/agent request, and that the applied
 * count is disclosed per paper.
 */

let nextPdfText: PdfText = { text: 'paper text', pages: 1, empty: false }
vi.mock('../model/pdfText', () => ({
  extractPdfText: vi.fn(async () => nextPdfText),
  countPdfPages: vi.fn(async () => 1),
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
  listLlmConfigs: async (): Promise<LlmConfig[]> => [],
  saveLlmConfig: async (config: LlmConfig) => [{ ...config, hasKey: true }],
  deleteLlmConfig: async () => [],
  callLlm: vi.fn<(request: LlmHttpRequest, signal?: AbortSignal) => Promise<LlmHttpResponse>>(),
  fetchWeb: async () => ({ ok: false, status: 0, url: '', contentType: '', body: '', truncated: false }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')
const { useAiStore, fewShotCandidates } = await import('./aiStore')

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
    usage: { input_tokens: 10, output_tokens: 5 },
  }),
})

const PROJECT = JSON.stringify({
  version: 1,
  title: 'Few-shot',
  config: { schema: [{ name: 'Summary', type: 'string' }, { name: 'Year', type: 'number' }] },
  papers: [
    { id: 'p1', title: 'Current paper', authors: [], pdf: 'p1.pdf', annotations: {} },
    { id: 'p2', title: 'Finished, one field', authors: [], pdf: 'p2.pdf', annotations: { Summary: [{ value: 'x' }] }, finished: true },
    { id: 'p3', title: 'Finished, two fields', authors: [], pdf: 'p3.pdf', annotations: { Summary: [{ value: 'y' }], Year: [{ value: 2020 }] }, finished: true },
    { id: 'p4', title: 'Not finished', authors: [], pdf: 'p4.pdf', annotations: { Summary: [{ value: 'z' }] } },
  ],
})

const st = () => useStore.getState()
const ai = () => useAiStore.getState()

beforeEach(() => {
  mockPlatform.callLlm.mockReset()
  runAgentMock.mockReset()
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
    mode: 'prompt',
    allPapers: false,
    fewShot: false,
    fewShotCount: 2,
    fewShotAvailable: 0,
    fewShotByPaper: {},
    phase: 'setup',
    error: null,
    elapsed: 0,
    targets: [],
    candidates: [],
    rows: [],
    notes: [],
    errors: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    runUsage: null,
    agentEvents: [],
    scanned: false,
  })
})

describe('fewShotCandidates: single-reviewer project', () => {
  it('picks finished papers, most-answered-fields-first, project order on ties', () => {
    const ids = fewShotCandidates(st().project!, null).map((c) => c.paperId)
    // p3 has two answered fields, p2 has one; p4 isn't finished; p1 is untouched.
    expect(ids).toEqual(['p3', 'p2'])
  })
})

describe('fewShotCandidates: multi-reviewer project', () => {
  it('prefers Consolidation when it has finished papers, over the current seat', () => {
    useStore.setState((s) => {
      s.project!.reviewers = 2
      s.project!.papers.forEach((p) => { p.finished = false })
      s.project!.papers[1].finished = true // p2 finished in Consolidation
    })
    st().selectReviewer('1')
    const ids = fewShotCandidates(st().project!, '1').map((c) => c.paperId)
    expect(ids).toEqual(['p2'])
  })

  it('falls back to the current human seat when Consolidation has nothing finished', () => {
    useStore.setState((s) => {
      s.project!.reviewers = 2
      s.project!.papers.forEach((p) => { p.finished = false })
    })
    st().selectReviewer('1')
    st().setFieldValue([], 'Summary', 0, 'reviewer 1 answer')
    st().setAnnotationFinished(true)
    const ids = fewShotCandidates(st().project!, '1').map((c) => c.paperId)
    expect(ids).toEqual(['p1'])
  })

  it("never sources from the AI's own seat, even if it is the seat currently selected", () => {
    useStore.setState((s) => {
      s.project!.reviewers = 2
      s.project!.aiSeat = true
      s.project!.papers.forEach((p) => { p.finished = false })
    })
    st().selectReviewer('2') // the AI seat
    st().setFieldValue([], 'Summary', 0, 'written by the AI seat')
    const ids = fewShotCandidates(st().project!, '2').map((c) => c.paperId)
    expect(ids).toEqual([])
  })
})

describe('run: prompt mode sends the few-shot block and records the count applied', () => {
  it('excludes the current paper and passes the block into the system prompt', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id, fewShot: true, fewShotCount: 5 })

    mockPlatform.callLlm.mockResolvedValueOnce(
      anthropicOk([{ path: 'Summary', value: 'result', evidence: 'e', confidence: 0.9 }]),
    )
    await ai().run()

    expect(mockPlatform.callLlm).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockPlatform.callLlm.mock.calls[0][0].body!)
    const system = body.system ?? body.messages?.find((m: { role: string }) => m.role === 'system')?.content
    expect(system).toContain('Worked examples from this review')
    expect(system).toContain('Finished, two fields')
    expect(system).not.toContain('Current paper')

    ai().apply()
    const usage = st().project!.papers.find((p) => p.id === 'p1')!.aiUsage
    expect(usage[0].fewShot).toBe(2)
  })

  it('sends nothing extra when the toggle is off', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id, fewShot: false })

    mockPlatform.callLlm.mockResolvedValueOnce(anthropicOk([]))
    await ai().run()

    const body = JSON.parse(mockPlatform.callLlm.mock.calls[0][0].body!)
    const system = body.system ?? body.messages?.find((m: { role: string }) => m.role === 'system')?.content
    expect(system).not.toContain('Worked examples from this review')
  })
})

describe('run: agent mode passes the block as AgentInput.examples', () => {
  it('includes the block and never the judge alone sees it', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id, mode: 'agent', fewShot: true, fewShotCount: 1 })

    runAgentMock.mockResolvedValueOnce({
      answer: { fields: [], skipped: [], rejected: [] },
      rounds: 1,
      usage: { inputTokens: 10, outputTokens: 5, calls: 1 },
      judgeUsage: { inputTokens: 0, outputTokens: 0, calls: 0 },
      log: [],
    })

    await ai().run()

    expect(runAgentMock).toHaveBeenCalledTimes(1)
    const input = runAgentMock.mock.calls[0][0]
    expect(input.examples).toContain('Worked examples from this review')
    // Only 1 requested: the most-complete candidate (p3).
    expect(input.examples).toContain('Finished, two fields')
    expect(input.examples).not.toContain('Finished, one field')
  })
})
