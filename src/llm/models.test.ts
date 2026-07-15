import { describe, it, expect } from 'vitest'
import { buildModelsRequest, parseModelsResponse } from './models'
import { PROVIDERS, PROVIDER_LIST } from './providers'
import { API_KEY_SENTINEL } from './types'
import type { LlmConfig, Provider } from './types'

function cfg(provider: Provider, over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: 'c1',
    name: 'test',
    provider,
    baseUrl: PROVIDERS[provider].defaultBaseUrl,
    model: 'the-model',
    attach: 'text',
    hasKey: true,
    ...over,
  }
}

describe('buildModelsRequest', () => {
  it('is a bare, sentinel-authenticated GET for every provider — never a real key', () => {
    for (const p of PROVIDER_LIST) {
      const req = buildModelsRequest(cfg(p.id, { baseUrl: 'http://x' }))
      expect(req.method).toBe('GET')
      expect(req.body).toBeUndefined()
      const serialized = JSON.stringify(req.headers)
      expect(serialized).toContain(API_KEY_SENTINEL)
      expect(serialized).not.toMatch(/sk-|[A-Za-z0-9_-]{20,}/)
    }
  })

  it('targets the documented list-models endpoint of each provider', () => {
    expect(buildModelsRequest(cfg('openai')).url).toBe('https://api.openai.com/v1/models')
    expect(buildModelsRequest(cfg('groq')).url).toBe('https://api.groq.com/openai/v1/models')
    expect(buildModelsRequest(cfg('mistral')).url).toBe('https://api.mistral.ai/v1/models')
    expect(buildModelsRequest(cfg('deepseek')).url).toBe('https://api.deepseek.com/v1/models')
    expect(buildModelsRequest(cfg('xai')).url).toBe('https://api.x.ai/v1/models')
    expect(buildModelsRequest(cfg('openai-compatible', { baseUrl: 'http://localhost:1234/v1' })).url).toBe(
      'http://localhost:1234/v1/models',
    )
    expect(buildModelsRequest(cfg('anthropic')).url).toBe(
      'https://api.anthropic.com/v1/models?limit=100',
    )
    expect(buildModelsRequest(cfg('google')).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    )
    expect(buildModelsRequest(cfg('openrouter')).url).toBe(
      'https://openrouter.ai/api/v1/models?limit=200',
    )
  })

  it('authenticates the way each provider\'s chat call does', () => {
    expect(buildModelsRequest(cfg('anthropic')).headers).toEqual({
      'x-api-key': API_KEY_SENTINEL,
      'anthropic-version': '2023-06-01',
    })
    expect(buildModelsRequest(cfg('google')).headers).toEqual({
      'x-goog-api-key': API_KEY_SENTINEL,
    })
    expect(buildModelsRequest(cfg('openai')).headers).toEqual({
      Authorization: `Bearer ${API_KEY_SENTINEL}`,
    })
  })

  it('pages Anthropic with after_id and Google with pageToken', () => {
    expect(buildModelsRequest(cfg('anthropic'), 'model_123').url).toBe(
      'https://api.anthropic.com/v1/models?limit=100&after_id=model_123',
    )
    expect(buildModelsRequest(cfg('google'), 'tok-abc').url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&pageToken=tok-abc',
    )
  })

  it('pages OpenRouter by replaying the "next" URL it handed back, against this target\'s origin', () => {
    const req = buildModelsRequest(cfg('openrouter'), '/api/v1/models?offset=200&limit=200')
    expect(req.url).toBe('https://openrouter.ai/api/v1/models?offset=200&limit=200')
  })
})

describe('parseModelsResponse: OpenAI-shaped providers', () => {
  const OPENAI_LIST = {
    object: 'list',
    data: [
      { id: 'gpt-5.6', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'gpt-5-chat-latest', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'o4-mini', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'text-embedding-3-large', object: 'model', created: 1, owned_by: 'openai' },
    ],
  }

  it('offers reasoning effort on o-series and gpt-5.x, but not their -chat siblings', () => {
    const { models } = parseModelsResponse('openai', OPENAI_LIST)
    expect(models.map((m) => m.id)).toEqual([
      'gpt-5.6',
      'gpt-5-chat-latest',
      'o4-mini',
      'text-embedding-3-large',
    ])
    expect(models.find((m) => m.id === 'gpt-5.6')?.reasoning?.levels).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ])
    expect(models.find((m) => m.id === 'gpt-5.6')?.reasoning?.defaultLevel).toBe('medium')
    expect(models.find((m) => m.id === 'o4-mini')?.reasoning).toBeTruthy()
    expect(models.find((m) => m.id === 'gpt-5-chat-latest')?.reasoning).toBeNull()
    expect(models.find((m) => m.id === 'text-embedding-3-large')?.reasoning).toBeNull()
  })

  it('offers reasoning effort only for the GPT-OSS family on Groq', () => {
    const { models } = parseModelsResponse('groq', {
      object: 'list',
      data: [
        { id: 'openai/gpt-oss-120b', object: 'model' },
        { id: 'qwen/qwen3-32b', object: 'model' },
        { id: 'llama-3.3-70b-versatile', object: 'model' },
      ],
    })
    expect(models.find((m) => m.id === 'openai/gpt-oss-120b')?.reasoning?.levels).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(models.find((m) => m.id === 'qwen/qwen3-32b')?.reasoning).toBeNull()
    expect(models.find((m) => m.id === 'llama-3.3-70b-versatile')?.reasoning).toBeNull()
  })

  it('offers reasoning effort only for grok-4.5 on xAI', () => {
    const { models } = parseModelsResponse('xai', {
      object: 'list',
      data: [{ id: 'grok-4.5' }, { id: 'grok-4' }, { id: 'grok-3-mini' }],
    })
    expect(models.find((m) => m.id === 'grok-4.5')?.reasoning?.levels).toEqual(['low', 'medium', 'high'])
    expect(models.find((m) => m.id === 'grok-4')?.reasoning).toBeNull()
    expect(models.find((m) => m.id === 'grok-3-mini')?.reasoning).toBeNull()
  })

  it('never offers reasoning effort for DeepSeek or a generic openai-compatible server', () => {
    // Deliberate: neither contract could be confirmed against primary docs
    // (DeepSeek) or is consistent across servers (llama.cpp/vLLM/LM Studio) —
    // see the file-level comment in models.ts.
    const shape = { object: 'list', data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-v4-pro' }] }
    expect(parseModelsResponse('deepseek', shape).models.every((m) => m.reasoning === null)).toBe(true)
    expect(
      parseModelsResponse('openai-compatible', shape).models.every((m) => m.reasoning === null),
    ).toBe(true)
  })

  it('drops entries with no usable id instead of throwing', () => {
    expect(parseModelsResponse('openai', { data: [{}, { id: 42 }, null, 'x'] }).models).toEqual([])
    expect(parseModelsResponse('openai', null).models).toEqual([])
    expect(parseModelsResponse('openai', {}).models).toEqual([])
    expect(parseModelsResponse('openai', 'not json').models).toEqual([])
  })
})

describe('parseModelsResponse: Anthropic', () => {
  it('reads reasoning support and its exact levels from capabilities.effort', () => {
    const json = {
      data: [
        {
          id: 'claude-opus-4-8',
          display_name: 'Claude Opus 4.8',
          type: 'model',
          capabilities: {
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: true },
              high: { supported: true },
              xhigh: { supported: true },
              max: { supported: true },
            },
          },
        },
        {
          id: 'claude-haiku-4-5-20251001',
          display_name: 'Claude Haiku 4.5',
          type: 'model',
          capabilities: { effort: { supported: false } },
        },
        { id: 'claude-legacy', type: 'model' }, // no capabilities at all
      ],
      first_id: 'claude-opus-4-8',
      last_id: 'claude-legacy',
      has_more: false,
    }
    const { models, nextCursor } = parseModelsResponse('anthropic', json)
    expect(models.map((m) => ({ id: m.id, label: m.label }))).toEqual([
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      { id: 'claude-legacy', label: 'claude-legacy' },
    ])
    expect(models[0].reasoning).toEqual({ levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'medium' })
    expect(models[1].reasoning).toBeNull()
    expect(models[2].reasoning).toBeNull()
    expect(nextCursor).toBeUndefined()
  })

  it('surfaces last_id as the next cursor only when has_more is true', () => {
    const page = (hasMore: boolean) => ({ data: [{ id: 'm', type: 'model' }], last_id: 'm', has_more: hasMore })
    expect(parseModelsResponse('anthropic', page(true)).nextCursor).toBe('m')
    expect(parseModelsResponse('anthropic', page(false)).nextCursor).toBeUndefined()
  })
})

describe('parseModelsResponse: Google', () => {
  it('strips the "models/" prefix, filters to generateContent models, and reads the thinking flag', () => {
    const json = {
      models: [
        {
          name: 'models/gemini-3-pro',
          displayName: 'Gemini 3 Pro',
          thinking: true,
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemini-2.0-flash',
          displayName: 'Gemini 2.0 Flash',
          thinking: false,
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/embedding-001',
          displayName: 'Embedding',
          supportedGenerationMethods: ['embedContent'],
        },
      ],
      nextPageToken: 'tok-2',
    }
    const { models, nextCursor } = parseModelsResponse('google', json)
    expect(models.map((m) => m.id)).toEqual(['gemini-3-pro', 'gemini-2.0-flash'])
    expect(models[0].label).toBe('Gemini 3 Pro')
    expect(models[0].reasoning?.levels).toEqual(['low', 'medium', 'high'])
    expect(models[1].reasoning).toBeNull()
    expect(nextCursor).toBe('tok-2')
  })

  it('has no next page when nextPageToken is absent or empty', () => {
    expect(parseModelsResponse('google', { models: [] }).nextCursor).toBeUndefined()
    expect(parseModelsResponse('google', { models: [], nextPageToken: '' }).nextCursor).toBeUndefined()
  })
})

describe('parseModelsResponse: OpenRouter', () => {
  it('reads supported_efforts as the levels, and links.next as the cursor', () => {
    const json = {
      data: [
        {
          id: 'x-ai/grok-4.5',
          name: 'Grok 4.5',
          reasoning: { supported_efforts: ['high', 'medium', 'low'], default_effort: 'high', mandatory: true },
        },
        { id: 'openrouter/auto', name: 'Auto' }, // no reasoning metadata at all
      ],
      total_count: 500,
      links: { next: '/api/v1/models?offset=200&limit=200' },
    }
    const { models, nextCursor } = parseModelsResponse('openrouter', json)
    expect(models[0].reasoning).toEqual({ levels: ['high', 'medium', 'low'], defaultLevel: 'medium' })
    expect(models[1].reasoning).toBeNull()
    expect(nextCursor).toBe('/api/v1/models?offset=200&limit=200')
  })

  it('has no next page when links.next is absent', () => {
    expect(parseModelsResponse('openrouter', { data: [] }).nextCursor).toBeUndefined()
  })
})

describe('parseModelsResponse: Mistral', () => {
  it('reads the bare array Mistral returns, not an OpenAI-style envelope', () => {
    const json = [
      { id: 'mistral-small-latest', object: 'model', capabilities: { completion_chat: true } },
      { id: 'mistral-medium-3-5', object: 'model', capabilities: { completion_chat: true } },
      { id: 'codestral-latest', object: 'model', capabilities: { completion_chat: true } },
    ]
    const { models } = parseModelsResponse('mistral', json)
    expect(models.map((m) => m.id)).toEqual(['mistral-small-latest', 'mistral-medium-3-5', 'codestral-latest'])
    expect(models[0].reasoning?.levels).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(models[1].reasoning).toBeTruthy()
    expect(models[2].reasoning).toBeNull()
  })

  it('also accepts a {data:[...]} envelope defensively, and [] for anything else', () => {
    expect(parseModelsResponse('mistral', { data: [{ id: 'x' }] }).models).toHaveLength(1)
    expect(parseModelsResponse('mistral', null).models).toEqual([])
    expect(parseModelsResponse('mistral', {}).models).toEqual([])
  })
})
