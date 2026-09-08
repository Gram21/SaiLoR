import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse } from '../llm/types'

/**
 * Data safety for a superseded run (its answer/rows never overwrite a newer
 * run's) is covered elsewhere via `applyAiSuggestions`. This file pins the
 * separate UI-safety promise: a stale run resolving late must not visibly move
 * `phase` backwards over a newer run that already reached `review`.
 */

let resolvers: Array<(res: LlmHttpResponse) => void> = []
const calls: LlmHttpRequest[] = []

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
  getPdfSource: async () => ({ url: 'blob:test' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async (config: LlmConfig) => [{ ...config, hasKey: true }],
  deleteLlmConfig: async () => [],
  callLlm: (request: LlmHttpRequest) => {
    calls.push(request)
    return new Promise<LlmHttpResponse>((resolve) => {
      resolvers.push(resolve)
    })
  },
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))
vi.stubGlobal(
  'fetch',
  async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Response,
)

const { useStore } = await import('./store')
const { useAiStore } = await import('./aiStore')

const PROJECT = JSON.stringify({
  version: 1,
  title: 'Run staleness',
  config: { schema: [{ name: 'Summary', type: 'string' }] },
  papers: [{ id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} }],
})

// `attach: 'pdf'` on a PDF-capable provider skips text extraction entirely,
// so the run needs no more than a fetchable (mocked) byte source.
function cfg(): LlmConfig {
  return {
    id: 'c1',
    name: 'test',
    provider: 'anthropic',
    baseUrl: '',
    model: 'claude',
    attach: 'pdf',
    hasKey: true,
  }
}

const ok = (): LlmHttpResponse => ({
  ok: true,
  status: 200,
  body: JSON.stringify({ content: [{ type: 'text', text: '{}' }] }),
})

beforeEach(() => {
  calls.length = 0
  resolvers = []
  useStore.getState().loadFromText(PROJECT, null, 'test.json')
  useStore.getState().selectPaper('p1')
  useAiStore.setState({
    configs: [cfg()],
    selectedId: 'c1',
    targets: [],
    phase: 'setup',
    answer: null,
    rows: [],
  })
})

describe('run: a superseded run does not move phase backwards', () => {
  it('leaves phase at review when a stale run resolves after a newer one already settled', async () => {
    const first = useAiStore.getState().run()
    await vi.waitFor(() => expect(resolvers.length).toBe(1))

    const second = useAiStore.getState().run()
    await vi.waitFor(() => expect(resolvers.length).toBe(2))

    resolvers[1]!(ok())
    await second
    expect(useAiStore.getState().phase).toBe('review')

    resolvers[0]!(ok())
    await first
    expect(useAiStore.getState().phase).toBe('review')
  })
})
