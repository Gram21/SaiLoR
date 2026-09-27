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
 * The human-in-the-loop review improvements: editing a proposal before
 * applying (REQ-LLM-580), confidence-aware defaults in prompt mode
 * (REQ-LLM-580), and skipping one paper mid-batch (REQ-LLM-590).
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
const { useAiStore } = await import('./aiStore')

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

function fakeAgentResult(over: Partial<AgentResult> = {}): AgentResult {
  return {
    answer: { fields: [], skipped: [], rejected: [] },
    rounds: 1,
    usage: { inputTokens: 10, outputTokens: 5, calls: 1 },
    judgeUsage: { inputTokens: 0, outputTokens: 0, calls: 0 },
    log: [],
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
  title: 'Edit',
  config: { schema: [{ name: 'Summary', type: 'string' }, { name: 'Count', type: 'number' }] },
  papers: [
    { id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} },
    { id: 'p2', title: 'Paper Two', authors: [], pdf: 'p2.pdf', annotations: {} },
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
  useAiStore.setState({
    configs: [],
    selectedId: null,
    mode: 'prompt',
    allPapers: false,
    confidenceThreshold: 0.8,
    phase: 'setup',
    error: null,
    elapsed: 0,
    targets: [],
    candidates: [],
    rows: [],
    notes: [],
    errors: [],
    skippedPapers: [],
    inFlightPapers: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    runUsage: null,
    agentEvents: [],
    scanned: false,
  })
})

describe('editRow: validated the same way parseAnswer coerces a model answer', () => {
  beforeEach(() => {
    useAiStore.setState({
      targetSeat: null,
      runUsage: { provider: 'anthropic', model: 'claude-x' },
      rows: [
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          suggestion: { path: 'Count', value: 3, evidence: 'e', confidence: 0.9 },
          checked: false,
        },
      ],
    })
  })

  it('rejects a value with no honest reading and leaves the row untouched', () => {
    const err = ai().editRow(0, 'not a number')
    expect(err).toBe('not a number')
    expect(ai().rows[0].edited).toBeFalsy()
    expect(ai().rows[0].checked).toBe(false)
  })

  it('accepts and coerces a valid value, ticking the row and recording the edit', () => {
    const err = ai().editRow(0, '42')
    expect(err).toBeNull()
    expect(ai().rows[0].edited).toBe(true)
    expect(ai().rows[0].editedValue).toBe(42)
    expect(ai().rows[0].checked).toBe(true)
    // The original AI proposal is kept for the "AI proposed: X" line.
    expect(ai().rows[0].suggestion.value).toBe(3)
  })

  it('rejects an unknown path', () => {
    useAiStore.setState((s) => {
      s.rows[0].suggestion = { ...s.rows[0].suggestion, path: 'Nonexistent' }
    })
    expect(ai().editRow(0, '1')).toBe('This field no longer exists in the schema.')
  })
})

describe('apply: writes the edited value and records the edited count', () => {
  it('writes editedValue instead of the AI proposal, and records `edited` on the usage record', () => {
    useAiStore.setState({
      targetSeat: null,
      runUsage: { provider: 'anthropic', model: 'claude-x' },
      mode: 'prompt',
      rows: [
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          suggestion: { path: 'Summary', value: 'AI value', evidence: 'e', confidence: 0.9 },
          checked: true,
        },
      ],
    })
    ai().editRow(0, 'reviewer value')
    ai().apply()

    const paper = st().project!.papers.find((p) => p.id === 'p1')!
    expect(paper.annotations.Summary?.[0]?.value).toBe('reviewer value')
    expect(paper.aiUsage.at(-1)?.edited).toBe(1)
  })

  it('omits `edited` when nothing was edited', () => {
    useAiStore.setState({
      targetSeat: null,
      runUsage: { provider: 'anthropic', model: 'claude-x' },
      mode: 'prompt',
      rows: [
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          suggestion: { path: 'Summary', value: 'AI value', evidence: 'e', confidence: 0.9 },
          checked: true,
        },
      ],
    })
    ai().apply()
    const paper = st().project!.papers.find((p) => p.id === 'p1')!
    expect(paper.aiUsage.at(-1)?.edited).toBeUndefined()
  })
})

describe('prompt mode: confidence-aware default (REQ-LLM-580)', () => {
  it('starts a below-threshold row unticked and flagged, an above-threshold row ticked, and a no-confidence row ticked', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id, mode: 'prompt', confidenceThreshold: 0.8 })
    mockPlatform.callLlm.mockResolvedValueOnce(
      anthropicOk([
        { path: 'Summary', value: 'low', evidence: 'e', confidence: 0.5 },
        { path: 'Count', value: 3, evidence: 'e', confidence: 0.95 },
      ]),
    )

    await ai().run()

    const low = ai().rows.find((r) => r.suggestion.path === 'Summary')!
    const high = ai().rows.find((r) => r.suggestion.path === 'Count')!
    expect(low.checked).toBe(false)
    expect(low.flagged).toBe(true)
    expect(high.checked).toBe(true)
    expect(high.flagged).toBeFalsy()
  })

  it('keeps a row with no reported confidence ticked', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({ configs: [c], selectedId: c.id, mode: 'prompt', confidenceThreshold: 0.8 })
    mockPlatform.callLlm.mockResolvedValueOnce(
      anthropicOk([{ path: 'Summary', value: 'no confidence', evidence: 'e', confidence: null }]),
    )

    await ai().run()

    expect(ai().rows[0].checked).toBe(true)
    expect(ai().rows[0].flagged).toBeFalsy()
  })
})

describe('skip one paper mid-batch (REQ-LLM-590)', () => {
  it('aborts only the skipped paper, keeps the batch going, and leaves it eligible for resume', async () => {
    const c = cfg({ attach: 'text' })
    useAiStore.setState({
      configs: [c],
      selectedId: c.id,
      mode: 'agent',
      allPapers: true,
      concurrency: 2,
      candidates: [
        { id: 'p1', title: 'Paper One' },
        { id: 'p2', title: 'Paper Two' },
      ],
    })

    const p1Resolve: { fn?: (r: AgentResult) => void } = {}
    let p2Aborted = false
    runAgentMock.mockImplementation(async (input) => {
      if (input.paper.id === 'p1') {
        return new Promise<AgentResult>((resolve) => {
          p1Resolve.fn = resolve
        })
      }
      // p2: hangs until its own signal aborts (never the whole batch's).
      return new Promise<AgentResult>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => {
          p2Aborted = true
          const err = new Error('Aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const runPromise = ai().run()
    await flush()
    expect(ai().inFlightPapers.map((p) => p.title).sort()).toEqual(['Paper One', 'Paper Two'])

    const p2 = ai().inFlightPapers.find((p) => p.title === 'Paper Two')!
    ai().skipPaper(p2.id)
    await flush()

    expect(p2Aborted).toBe(true)
    // p1 is untouched by the skip — it can still finish normally.
    p1Resolve.fn?.(
      fakeAgentResult({
        answer: { fields: [{ path: 'Summary', value: 'from p1', evidence: 'e', confidence: 0.9, source: 'paper' }], skipped: [], rejected: [] },
      }),
    )
    await runPromise

    expect(ai().phase).toBe('review')
    expect(ai().rows).toHaveLength(1)
    expect(ai().rows[0].paperId).toBe('p1')
    expect(ai().errors).toHaveLength(0) // a skip is not an error
    expect(ai().skippedPapers).toEqual([{ paperId: 'p2', paperTitle: 'Paper Two' }])

    // Resuming re-runs the skipped paper, since it was never added to doneIds.
    runAgentMock.mockReset()
    runAgentMock.mockResolvedValue(fakeAgentResult())
    await ai().resumeBatch()

    expect(runAgentMock).toHaveBeenCalledTimes(1)
    expect(runAgentMock.mock.calls[0][0].paper.id).toBe('p2')
  })
})
