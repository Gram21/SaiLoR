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
 * Parallel all-papers batches (REQ-LLM-500) and resuming one stopped mid-way
 * (REQ-LLM-510): `concurrency` bounds how many papers `runPool` runs at once,
 * progress is persisted to localStorage after every finished paper, and
 * `resumeBatch()` continues only the papers a saved batch hasn't finished yet.
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

const PROJECT = JSON.stringify({
  version: 1,
  title: 'Resume',
  config: { schema: [{ name: 'Summary', type: 'string' }] },
  papers: [
    { id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} },
    { id: 'p2', title: 'Paper Two', authors: [], pdf: 'p2.pdf', annotations: {} },
    { id: 'p3', title: 'Paper Three', authors: [], pdf: 'p3.pdf', annotations: {} },
  ],
})

const st = () => useStore.getState()
const ai = () => useAiStore.getState()

function batchKey(): string {
  return `slr.llm.batch.${st().project!.title}.`
}

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
  const c = cfg()
  useAiStore.setState({
    configs: [c],
    selectedId: c.id,
    mode: 'agent',
    allPapers: true,
    fewShot: false,
    candidates: [
      { id: 'p1', title: 'Paper One' },
      { id: 'p2', title: 'Paper Two' },
      { id: 'p3', title: 'Paper Three' },
    ],
    concurrency: 2,
    targetSeat: null,
    phase: 'setup',
    error: null,
    elapsed: 0,
    targets: [],
    rows: [],
    notes: [],
    errors: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    runUsage: null,
    agentEvents: [],
    scanned: false,
  })
})

describe('concurrency: at most `concurrency` papers run at once', () => {
  it('starts a third paper only once one of the first two finishes', async () => {
    const inFlight: string[] = []
    let maxConcurrent = 0
    const deferreds: Array<() => void> = []
    runAgentMock.mockImplementation(async (input) => {
      inFlight.push(input.paper.id)
      maxConcurrent = Math.max(maxConcurrent, inFlight.length)
      await new Promise<void>((resolve) => deferreds.push(resolve))
      inFlight.splice(inFlight.indexOf(input.paper.id), 1)
      return fakeAgentResult()
    })

    const runPromise = ai().run()
    await flush()
    expect(runAgentMock).toHaveBeenCalledTimes(2) // concurrency 2: p1 and p2, not p3 yet
    expect(ai().inFlightPapers.map((p) => p.title).sort()).toEqual(['Paper One', 'Paper Two'])

    deferreds[0]() // let p1 finish
    await flush()
    expect(runAgentMock).toHaveBeenCalledTimes(3) // p3 now started

    deferreds[1]()
    deferreds[2]()
    await runPromise

    expect(maxConcurrent).toBe(2)
    expect(ai().batchDone).toBe(3)
  })
})

describe('persistence: written after each paper, cleared on apply/discard', () => {
  it('persists doneIds incrementally, then clears on apply', async () => {
    runAgentMock.mockResolvedValue(fakeAgentResult())
    useAiStore.setState({ concurrency: 1 })

    await ai().run()

    expect(ai().phase).toBe('review')
    const saved = JSON.parse(localStorage.getItem(batchKey())!)
    expect(saved.doneIds.sort()).toEqual(['p1', 'p2', 'p3'])

    ai().apply()
    expect(localStorage.getItem(batchKey())).toBeNull()
  })

  it('clears the saved batch on discard', async () => {
    runAgentMock.mockResolvedValue(fakeAgentResult())
    useAiStore.setState({ concurrency: 1 })

    await ai().run()
    expect(localStorage.getItem(batchKey())).not.toBeNull()

    ai().discardBatch()
    expect(localStorage.getItem(batchKey())).toBeNull()
  })
})

describe('resume: continues only the remaining papers', () => {
  it('runs only papers missing from doneIds, keeping restored rows', async () => {
    runAgentMock.mockResolvedValueOnce(
      fakeAgentResult({
        answer: { fields: [{ path: 'Summary', value: 'p1 value', evidence: 'e', confidence: 0.9, source: 'paper' }], skipped: [], rejected: [] },
      }),
    )
    useAiStore.setState({ concurrency: 1 })
    // p2's call: never resolves on its own — only rejects when `cancel()`
    // aborts the signal, same as a real in-flight HTTP request would.
    runAgentMock.mockImplementationOnce(
      (input) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    )

    const runPromise = ai().run()
    await flush()
    ai().cancel()
    await runPromise

    expect(ai().phase).toBe('review')
    expect(ai().rows).toHaveLength(1) // only p1 landed before cancel
    runAgentMock.mockReset()
    runAgentMock.mockResolvedValue(fakeAgentResult())

    await ai().resumeBatch()

    expect(ai().phase).toBe('review')
    // p1's row survives the resume; p2 and p3 were (re)run to get here.
    expect(ai().rows.map((r) => r.paperId)).toContain('p1')
    expect(runAgentMock).toHaveBeenCalledTimes(2) // p2 and p3 only
    const calledPaperIds = runAgentMock.mock.calls.map((c) => c[0].paper.id).sort()
    expect(calledPaperIds).toEqual(['p2', 'p3'])
  })
})

describe('resume: ignores a saved batch for a different project or seat', () => {
  it('does not offer resume when the persisted key belongs to another project', () => {
    localStorage.setItem(
      'slr.llm.batch.Some Other Project.',
      JSON.stringify({
        version: 1,
        mode: 'agent',
        configId: 'c1',
        judgeId: null,
        allPaperIds: ['p1'],
        doneIds: [],
        usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
        spent: 0,
        startedAt: new Date().toISOString(),
      }),
    )

    // Nothing saved under *this* project's key — resumeBatch is a no-op.
    return ai()
      .resumeBatch()
      .then(() => {
        expect(ai().rows).toEqual([])
      })
  })

  it('ignores a stale record whose configured target no longer exists', async () => {
    localStorage.setItem(
      batchKey(),
      JSON.stringify({
        version: 1,
        mode: 'agent',
        configId: 'gone',
        judgeId: null,
        allPaperIds: ['p1', 'p2'],
        doneIds: ['p1'],
        usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
        spent: 0,
        startedAt: new Date().toISOString(),
      }),
    )

    await ai().resumeBatch()
    expect(ai().rows).toEqual([])
    expect(runAgentMock).not.toHaveBeenCalled()
  })
})
