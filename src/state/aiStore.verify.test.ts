import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse } from '../llm/types'

/**
 * `verifyConfig` is "Verify setup"'s one-word smoke test: it must save the
 * draft config before calling (the key is never held by the renderer), surface
 * the provider's own error message on a non-ok response, and tell a genuinely
 * empty reply apart from one that only ran out of budget on hidden reasoning
 * — those need different advice to the reviewer.
 */

let nextResponse: LlmHttpResponse = { ok: false, status: 500, body: '{}' }
const savedKeys: Array<string | undefined> = []

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
  saveLlmConfig: async (config: LlmConfig, apiKey?: string) => {
    savedKeys.push(apiKey)
    return [{ ...config, hasKey: true }]
  },
  deleteLlmConfig: async () => [],
  callLlm: async (_request: LlmHttpRequest) => nextResponse,
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useAiStore } = await import('./aiStore')

function cfg(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: 'c-anthropic',
    name: 'test',
    provider: 'anthropic',
    baseUrl: '',
    model: 'claude-x',
    attach: 'text',
    hasKey: false,
    ...over,
  }
}

const st = () => useAiStore.getState()

beforeEach(() => {
  savedKeys.length = 0
  nextResponse = { ok: false, status: 500, body: '{}' }
})

describe('verifyConfig', () => {
  it('saves the draft config with its key before calling, so the key is in place first', async () => {
    nextResponse = { ok: true, status: 200, body: JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }) }
    await st().verifyConfig(cfg(), 'sk-fake')
    expect(savedKeys).toEqual(['sk-fake'])
  })

  it('returns the model reply text on success', async () => {
    nextResponse = { ok: true, status: 200, body: JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }) }
    await expect(st().verifyConfig(cfg(), 'sk-fake')).resolves.toBe('OK')
  })

  it('throws the provider\'s own error message when the call fails', async () => {
    nextResponse = { ok: false, status: 401, body: '{"error":{"message":"invalid api key"}}' }
    await expect(st().verifyConfig(cfg(), 'sk-fake')).rejects.toThrow('invalid api key')
  })

  it('reports a plain empty reply as such, not as truncation', async () => {
    nextResponse = { ok: true, status: 200, body: JSON.stringify({ content: [] }) }
    await expect(st().verifyConfig(cfg(), 'sk-fake')).rejects.toThrow(
      'The provider answered, but the reply was empty.',
    )
  })

  it('tells a reasoning-budget truncation apart from a genuinely empty reply', async () => {
    // stop_reason: max_tokens with no text block means the whole budget went to
    // hidden reasoning before the model ever got to an answer.
    nextResponse = { ok: true, status: 200, body: JSON.stringify({ content: [], stop_reason: 'max_tokens' }) }
    await expect(st().verifyConfig(cfg(), 'sk-fake')).rejects.toThrow(/whole reply budget on internal/)
  })
})
