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
 * The separate-judge-target feature (REQ-LLM-480), the all-papers spending
 * cap (REQ-LLM-490), and `apply()`'s per-paper disclosure fields (mode, judge,
 * rounds, applied-verdict counts — REQ-LLM-240).
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
    name: 'agent target',
    provider: 'anthropic',
    baseUrl: '',
    model: 'claude-agent',
    attach: 'text',
    hasKey: true,
    ...over,
  }
}

const judgeCfgFixture: LlmConfig = {
  id: 'c2',
  name: 'judge target',
  provider: 'openai',
  baseUrl: '',
  model: 'gpt-judge',
  attach: 'text',
  hasKey: true,
  inputPrice: 1,
  outputPrice: 2,
}

const PROJECT = JSON.stringify({
  version: 1,
  title: 'Judge',
  config: { schema: [{ name: 'Summary', type: 'string' }] },
  papers: [
    { id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} },
    { id: 'p2', title: 'Paper Two', authors: [], pdf: 'p2.pdf', annotations: {} },
  ],
})

const st = () => useStore.getState()
const ai = () => useAiStore.getState()

function fakeAgentResult(over: Partial<AgentResult> = {}): AgentResult {
  return {
    answer: { fields: [], skipped: [], rejected: [] },
    rounds: 1,
    usage: { inputTokens: 100, outputTokens: 40, calls: 2 },
    judgeUsage: { inputTokens: 0, outputTokens: 0, calls: 0 },
    log: [],
    ...over,
  }
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
    judgeSelectedId: null,
    spendCap: null,
    spentSoFar: 0,
    spendCapHit: false,
    retryNotice: null,
    mode: 'agent',
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
    runJudge: null,
    roundsByPaper: {},
    agentEvents: [],
    scanned: false,
  })
})

describe('judge selection: persisted like the selected target', () => {
  it('defaults to null ("same as agent") and persists a choice', () => {
    expect(ai().judgeSelectedId).toBeNull()
    ai().selectJudge('c2')
    expect(ai().judgeSelectedId).toBe('c2')
    expect(localStorage.getItem('slr.llm.judge')).toBe('c2')
  })

  it('clears back to null when set again', () => {
    ai().selectJudge('c2')
    ai().selectJudge(null)
    expect(ai().judgeSelectedId).toBeNull()
    expect(localStorage.getItem('slr.llm.judge')).toBeNull()
  })

  it('falls back to null when the stored judge target no longer exists among fetched configs', async () => {
    useAiStore.setState({ judgeSelectedId: 'gone' })
    mockPlatform.listLlmConfigs = async () => [cfg()]
    await ai().refreshConfigs()
    expect(ai().judgeSelectedId).toBeNull()
  })

  it('leaves a still-valid judge selection alone on refresh', async () => {
    useAiStore.setState({ judgeSelectedId: 'c2' })
    mockPlatform.listLlmConfigs = async () => [cfg(), judgeCfgFixture]
    await ai().refreshConfigs()
    expect(ai().judgeSelectedId).toBe('c2')
  })
})

describe('run: judgeConfig passed to runAgent', () => {
  it('passes the picked judge target as judgeConfig, distinct from the agent config', async () => {
    const agentCfg = cfg()
    useAiStore.setState({ configs: [agentCfg, judgeCfgFixture], selectedId: agentCfg.id, judgeSelectedId: judgeCfgFixture.id, mode: 'agent' })
    runAgentMock.mockResolvedValueOnce(fakeAgentResult())

    await ai().run()

    expect(runAgentMock).toHaveBeenCalledTimes(1)
    const input = runAgentMock.mock.calls[0][0]
    expect(input.config).toEqual(agentCfg)
    expect(input.judgeConfig).toEqual(judgeCfgFixture)
    expect(ai().runJudge).toEqual({ provider: judgeCfgFixture.provider, model: judgeCfgFixture.model })
  })

  it('passes no judgeConfig ("same as agent") when nothing is picked', async () => {
    const agentCfg = cfg()
    useAiStore.setState({ configs: [agentCfg], selectedId: agentCfg.id, judgeSelectedId: null, mode: 'agent' })
    runAgentMock.mockResolvedValueOnce(fakeAgentResult())

    await ai().run()

    const input = runAgentMock.mock.calls[0][0]
    expect(input.judgeConfig).toBeUndefined()
    expect(ai().runJudge).toEqual({ provider: agentCfg.provider, model: agentCfg.model })
  })

  it('refuses to run when the picked judge target has no API key', async () => {
    const agentCfg = cfg()
    const keylessJudge = { ...judgeCfgFixture, hasKey: false }
    useAiStore.setState({ configs: [agentCfg, keylessJudge], selectedId: agentCfg.id, judgeSelectedId: keylessJudge.id, mode: 'agent' })

    await ai().run()

    expect(runAgentMock).not.toHaveBeenCalled()
    expect(ai().phase).toBe('error')
    expect(ai().error).toMatch(/judge/i)
  })
})

describe('run: spending cap stops an all-papers batch', () => {
  it('stops starting new papers once spent exceeds the cap, keeping what finished', async () => {
    const agentCfg = cfg({ inputPrice: 3, outputPrice: 15 })
    useAiStore.setState({
      configs: [agentCfg],
      selectedId: agentCfg.id,
      mode: 'agent',
      allPapers: true,
      candidates: [{ id: 'p1', title: 'Paper One' }, { id: 'p2', title: 'Paper Two' }],
      spendCap: 0.001, // Blown through by the very first paper's usage.
    })
    runAgentMock.mockResolvedValue(fakeAgentResult({ usage: { inputTokens: 100_000, outputTokens: 40_000, calls: 2 } }))

    await ai().run()

    expect(runAgentMock).toHaveBeenCalledTimes(1)
    expect(ai().spendCapHit).toBe(true)
    expect(ai().spentSoFar).toBeGreaterThan(0.001)
    expect(ai().phase).toBe('review')
  })

  it('does not apply the cap outside all-papers mode', async () => {
    const agentCfg = cfg({ inputPrice: 3, outputPrice: 15 })
    useAiStore.setState({
      configs: [agentCfg],
      selectedId: agentCfg.id,
      mode: 'agent',
      allPapers: false,
      spendCap: 0.001,
    })
    runAgentMock.mockResolvedValue(fakeAgentResult())

    await ai().run()

    expect(runAgentMock).toHaveBeenCalledTimes(1)
    expect(ai().spendCapHit).toBe(false)
  })
})

describe('apply: usage disclosure fields', () => {
  it('passes mode/judge/rounds and verdict counts of only the applied rows to applyAiSuggestionsBatch', () => {
    const agentCfg = cfg()
    useAiStore.setState({
      runUsage: { provider: agentCfg.provider, model: agentCfg.model },
      runJudge: { provider: judgeCfgFixture.provider, model: judgeCfgFixture.model },
      mode: 'agent',
      roundsByPaper: { p1: 2 },
      rows: [
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          suggestion: { path: 'Summary', value: 'accepted', evidence: 'e', confidence: 0.9, judge: { verdict: 'accept', feedback: '' } },
          checked: true,
        },
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          suggestion: { path: 'Summary', value: 'revise-me', evidence: 'e2', confidence: 0.4, judge: { verdict: 'revise', feedback: 'x' } },
          checked: false, // unchecked: must NOT count toward verdicts
        },
      ],
    })

    const original = useStore.getState().applyAiSuggestionsBatch
    const calls: Parameters<typeof original>[0][] = []
    useStore.setState({
      applyAiSuggestionsBatch: (items) => {
        calls.push(items)
        return original(items)
      },
    })

    ai().apply()

    expect(calls).toHaveLength(1)
    const items = calls[0]
    expect(items).toHaveLength(1)
    expect(items[0].usage).toMatchObject({
      provider: agentCfg.provider,
      model: agentCfg.model,
      mode: 'agent',
      judge: { provider: judgeCfgFixture.provider, model: judgeCfgFixture.model },
      rounds: 2,
      verdicts: { accept: 1, revise: 0, reject: 0 },
    })
  })

  it('omits mode-specific fields in prompt mode', () => {
    const promptCfg = cfg()
    useAiStore.setState({
      runUsage: { provider: promptCfg.provider, model: promptCfg.model },
      runJudge: null,
      mode: 'prompt',
      roundsByPaper: {},
      rows: [
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          suggestion: { path: 'Summary', value: 'a value', evidence: 'e', confidence: 0.9 },
          checked: true,
        },
      ],
    })

    const original = useStore.getState().applyAiSuggestionsBatch
    const calls: Parameters<typeof original>[0][] = []
    useStore.setState({
      applyAiSuggestionsBatch: (items) => {
        calls.push(items)
        return original(items)
      },
    })

    ai().apply()

    const items = calls[0]
    expect(items[0].usage).toEqual({ provider: promptCfg.provider, model: promptCfg.model, mode: 'prompt' })
  })
})
