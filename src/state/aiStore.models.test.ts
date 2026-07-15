import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse } from '../llm/types'

/**
 * `fetchModels` is the one place this app ever asks a provider "what models do
 * you have" — and for `openai-compatible` it must never ask at all: there is
 * no single endpoint/shape safe to assume for an arbitrary self-hosted server
 * (see `supportsModelListing` in `providers.ts`). This file pins that as a
 * behavioral contract, not just a UI hint: the call is skipped at the store
 * layer, so no future UI trigger can bypass it by forgetting to check first.
 */

const calls: LlmHttpRequest[] = []
let nextResponse: LlmHttpResponse = { ok: false, status: 500, body: '{}' }

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
  getPdfSource: async () => ({ url: '' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async (config: LlmConfig) => [{ ...config, hasKey: true }],
  deleteLlmConfig: async () => [],
  callLlm: async (request: LlmHttpRequest) => {
    calls.push(request)
    return nextResponse
  },
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useAiStore } = await import('./aiStore')

function cfg(provider: LlmConfig['provider'], over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: `c-${provider}`,
    name: 'test',
    provider,
    baseUrl: provider === 'openai-compatible' ? 'http://localhost:1234' : '',
    model: '',
    attach: 'text',
    hasKey: false,
    ...over,
  }
}

const st = () => useAiStore.getState()

beforeEach(() => {
  calls.length = 0
  nextResponse = { ok: false, status: 500, body: '{}' }
  useAiStore.setState({ models: {}, modelsLoading: {}, modelsError: {}, modelsFetchedAt: {} })
})

describe('fetchModels: openai-compatible is never queried', () => {
  it('makes no request and leaves no trace of loading/error/result state', async () => {
    const config = cfg('openai-compatible')
    await st().fetchModels(config, 'sk-fake')

    expect(calls).toEqual([])
    expect(st().models[config.id]).toBeUndefined()
    expect(st().modelsLoading[config.id]).toBeUndefined()
    expect(st().modelsError[config.id]).toBeUndefined()
    expect(st().modelsFetchedAt[config.id]).toBeUndefined()
  })

  it('does not even save the draft target first, unlike a listable provider', async () => {
    // verifyConfig/fetchModels on a listable provider save the draft so the key
    // is in place before the call — openai-compatible must skip that step too,
    // since there is nothing here that will use the key.
    const saveConfig = vi.spyOn(st(), 'saveConfig')
    await st().fetchModels(cfg('openai-compatible'), 'sk-fake')
    expect(saveConfig).not.toHaveBeenCalled()
    saveConfig.mockRestore()
  })
})

describe('fetchModels: a listable provider is queried normally', () => {
  it('calls the platform and records the failure, proving the guard is provider-specific', async () => {
    nextResponse = { ok: false, status: 401, body: '{"error":{"message":"invalid api key"}}' }
    const config = cfg('anthropic')

    await st().fetchModels(config, 'sk-fake')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('api.anthropic.com/v1/models')
    expect(st().modelsError[config.id]).toContain('invalid api key')
    expect(st().modelsLoading[config.id]).toBe(false)
  })
})
