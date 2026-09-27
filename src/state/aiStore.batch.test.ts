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
 * Everything `run()` does beyond the single-paper prompt-mode flow already
 * pinned by `aiStore.run.test.ts`: mode persistence, which papers "annotate
 * all papers" picks up, a batch that keeps going past a paper that errors,
 * cancelling mid-batch, and agent mode (mocked `runAgent`) including the
 * judge-verdict default-checked rule.
 */

let nextPdfText: PdfText = { text: 'paper text', pages: 1, empty: false }
vi.mock('../model/pdfText', () => ({
  extractPdfText: vi.fn(async () => nextPdfText),
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
  listLlmConfigs: async () => [],
  saveLlmConfig: async (config: LlmConfig) => [{ ...config, hasKey: true }],
  deleteLlmConfig: async () => [],
  callLlm: vi.fn<(request: LlmHttpRequest, signal?: AbortSignal) => Promise<LlmHttpResponse>>(),
  fetchWeb: async () => ({ ok: false, status: 0, url: '', contentType: '', body: '', truncated: false }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')
const { useAiStore, batchCandidates } = await import('./aiStore')

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
  title: 'Batch',
  config: { schema: [{ name: 'Summary', type: 'string' }] },
  papers: [
    { id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} },
    { id: 'p2', title: 'Paper Two', authors: [], pdf: 'p2.pdf', annotations: {} },
    { id: 'p3', title: 'No PDF', authors: [], pdf: 'p3.pdf', annotations: {} },
  ],
})

const st = () => useStore.getState()
const ai = () => useAiStore.getState()

async function flush(times = 40) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

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
  // Mutated after loading, not in the fixture: the loader itself requires
  // every non-screening paper to have a PDF path, so "no PDF" can only be
  // reached this way — batchCandidates only cares about the in-memory shape.
  useStore.setState((s) => {
    s.project!.papers[2].pdf = ''
  })
  useAiStore.setState({
    configs: [],
    selectedId: null,
    mode: 'prompt',
    allPapers: false,
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

describe('mode: persisted like the selected target', () => {
  it('defaults to prompt mode and switches/persists agent mode', () => {
    expect(ai().mode).toBe('prompt')
    ai().setMode('agent')
    expect(ai().mode).toBe('agent')
    expect(localStorage.getItem('slr.llm.mode')).toBe('agent')
  })
})

describe('batchCandidates: who "annotate all papers" picks up', () => {
  it('excludes a paper with no PDF', () => {
    const ids = batchCandidates(st().project!, null).map((c) => c.id)
    expect(ids).toEqual(['p1', 'p2'])
  })

  it('excludes a paper with every field already answered', () => {
    st().setFieldValue([], 'Summary', 0, 'answered')
    const ids = batchCandidates(st().project!, null).map((c) => c.id)
    expect(ids).toEqual(['p2'])
  })

  it('excludes a paper finished for this seat, even with fields still empty', () => {
    st().setAnnotationFinished(true)
    const ids = batchCandidates(st().project!, null).map((c) => c.id)
    expect(ids).toEqual(['p2'])
  })
})

describe('batchCandidates: routing into the AI seat (REQ-LLM-470)', () => {
  it('checks the AI seat, not the passed-in seat, when the project has one', () => {
    useStore.setState((s) => {
      s.project!.reviewers = 2
      s.project!.aiSeat = true
    })
    // Nobody selected ('null') would normally have nothing to check against —
    // the AI seat is checked instead.
    const withNobodySelected = batchCandidates(st().project!, null).map((c) => c.id)
    expect(withNobodySelected).toEqual(['p1', 'p2'])

    st().selectReviewer('2') // the AI seat itself
    st().setFieldValue([], 'Summary', 0, 'in the AI seat')
    const afterAiSeatAnswered = batchCandidates(st().project!, null).map((c) => c.id)
    expect(afterAiSeatAnswered).toEqual(['p2'])
  })

  it('allows Consolidation as the passed-in seat when the project has an AI seat', () => {
    useStore.setState((s) => {
      s.project!.reviewers = 2
      s.project!.aiSeat = true
    })
    const ids = batchCandidates(st().project!, 'consolidation').map((c) => c.id)
    expect(ids).toEqual(['p1', 'p2'])
  })
})

describe('run: batch continues past a failing paper', () => {
  it('records the failure and keeps going, ending in review with what succeeded', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id, allPapers: true, candidates: [{ id: 'p1', title: 'Paper One' }, { id: 'p2', title: 'Paper Two' }] })

    // 400, not 500: a run's calls are now wrapped in `withRetry` (retry.ts), which
    // retries the 5xx family — a non-retryable status keeps this test about the
    // batch's own "continue past a failing paper" behavior, not retry timing.
    mockPlatform.callLlm
      .mockResolvedValueOnce({ ok: false, status: 400, body: 'boom' })
      .mockResolvedValueOnce(anthropicOk([{ path: 'Summary', value: 'from p2', evidence: 'e', confidence: 0.9 }]))

    await ai().run()

    expect(ai().phase).toBe('review')
    expect(ai().errors).toHaveLength(1)
    expect(ai().errors[0].paperId).toBe('p1')
    expect(ai().rows).toHaveLength(1)
    expect(ai().rows[0].paperId).toBe('p2')
    expect(ai().rows[0].suggestion.value).toBe('from p2')
  })
})

describe('run: cancel mid-batch keeps what already finished', () => {
  it('stops after the in-flight paper aborts and goes to review with the finished ones', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id, allPapers: true, candidates: [{ id: 'p1', title: 'Paper One' }, { id: 'p2', title: 'Paper Two' }] })

    const held: { resolve?: (r: LlmHttpResponse) => void } = {}
    mockPlatform.callLlm
      .mockResolvedValueOnce(anthropicOk([{ path: 'Summary', value: 'from p1', evidence: 'e', confidence: 0.9 }]))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            held.resolve = resolve
          }),
      )

    const runPromise = ai().run()
    await flush()
    expect(ai().batchDone).toBe(1) // first paper done
    expect(ai().inFlightPapers.map((p) => p.title)).toEqual(['Paper Two']) // second in flight

    ai().cancel()
    held.resolve?.(anthropicOk([]))
    await runPromise

    expect(ai().phase).toBe('review')
    expect(ai().rows).toHaveLength(1)
    expect(ai().rows[0].paperId).toBe('p1')
    // The cancelled paper is neither a row nor a recorded failure.
    expect(ai().errors).toHaveLength(0)
  })
})

describe('run: agent mode', () => {
  it('uses runAgent, sums its usage, and defaults non-accept verdicts unchecked', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id, mode: 'agent' })

    runAgentMock.mockResolvedValueOnce({
      answer: {
        fields: [
          { path: 'Summary', value: 'accepted value', evidence: 'e1', confidence: 0.9, source: 'paper', judge: { verdict: 'accept', feedback: '' } },
        ],
        skipped: [],
        rejected: [],
      },
      rounds: 1,
      usage: { inputTokens: 100, outputTokens: 40, calls: 3 },
      judgeUsage: { inputTokens: 0, outputTokens: 0, calls: 0 },
      log: [],
    })

    await ai().run()

    expect(ai().phase).toBe('review')
    expect(runAgentMock).toHaveBeenCalledTimes(1)
    expect(ai().usage).toEqual({ calls: 3, inputTokens: 100, outputTokens: 40 })
    expect(ai().rows).toHaveLength(1)
    expect(ai().rows[0].checked).toBe(true)
  })

  it('leaves a revise/reject verdict, or no verdict at all, unchecked', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id, mode: 'agent' })

    runAgentMock.mockResolvedValueOnce({
      answer: {
        fields: [
          { path: 'Summary', value: 'needs work', evidence: 'e1', confidence: 0.5, judge: { verdict: 'revise', feedback: 'check this' } },
        ],
        skipped: [],
        rejected: [],
      },
      rounds: 1,
      usage: { inputTokens: 10, outputTokens: 5, calls: 1 },
      judgeUsage: { inputTokens: 0, outputTokens: 0, calls: 0 },
      log: [],
    })

    await ai().run()

    expect(ai().rows).toHaveLength(1)
    expect(ai().rows[0].checked).toBe(false)
    expect(ai().rows[0].suggestion.judge?.verdict).toBe('revise')
  })
})
