import { describe, it, expect } from 'vitest'
import {
  OLLAMA_SHORTLIST,
  capabilitiesOf,
  computeNumCtx,
  contextOf,
  drainNdjson,
  estimateKvBytes,
  estimateTokens,
  gpuStatus,
  inputWasTruncated,
  isValidModelTag,
  manifestUrl,
  numCtxOfBody,
  ollamaNumCtx,
  parseLlamaCppProps,
  parseLmStudioModels,
  parseOpenAiModelsMeta,
  parsePs,
  parsePullLine,
  parseTags,
  sumManifestBytes,
  thinkingOf,
} from './ollama'

// Fixtures follow the response shapes in the Ollama / LM Studio / llama.cpp / vLLM docs (read 2026-10-02).
const TAGS = {
  models: [
    {
      name: 'qwen3.5:9b',
      model: 'qwen3.5:9b',
      size: 6_600_000_000,
      digest: 'abc',
      details: { parameter_size: '9B', quantization_level: 'Q4_K_M', family: 'qwen3' },
    },
    { name: 'tiny:latest', size: 1 },
    { nope: true },
  ],
}

const SHOW = {
  capabilities: ['completion', 'tools', 'thinking'],
  model_info: {
    'general.architecture': 'qwen3',
    'qwen3.context_length': 262144,
    'qwen3.block_count': 36,
    'qwen3.attention.head_count': 32,
    'qwen3.attention.head_count_kv': 8,
    'qwen3.attention.key_length': 128,
    'qwen3.embedding_length': 4096,
  },
  thinking: { values: ['low', 'medium', 'high'], default: 'medium' },
}

describe('ollama parsers', () => {
  it('parses /api/tags and skips malformed entries', () => {
    const models = parseTags(TAGS)
    expect(models.map((m) => m.name)).toEqual(['qwen3.5:9b', 'tiny:latest'])
    expect(models[0]).toMatchObject({ sizeBytes: 6_600_000_000, parameterSize: '9B', quantization: 'Q4_K_M', family: 'qwen3' })
    expect(parseTags('x')).toEqual([])
  })

  it('reads capabilities, context and thinking from /api/show', () => {
    expect(capabilitiesOf(SHOW)).toEqual(['completion', 'tools', 'thinking'])
    expect(contextOf(SHOW)).toBe(262144)
    expect(thinkingOf(SHOW)).toEqual({ values: ['low', 'medium', 'high'], default: 'medium' })
    expect(contextOf({ model_info: { 'general.architecture': 'x' } })).toBeNull()
    expect(contextOf(null)).toBeNull()
    expect(thinkingOf({})).toBeNull()
  })

  it('estimates the KV cache as 2 * layers * kv heads * head dim * 2 bytes * ctx', () => {
    expect(estimateKvBytes(SHOW.model_info, 8192)).toBe(2 * 36 * 8 * 128 * 2 * 8192)
  })

  it('derives head dim from embedding/heads and tolerates per-layer arrays; null when fields are missing', () => {
    const info = {
      'general.architecture': 'a',
      'a.block_count': 10,
      'a.attention.head_count': 16,
      'a.attention.head_count_kv': [2, 4, 4],
      'a.embedding_length': 2048,
    }
    expect(estimateKvBytes(info, 1000)).toBe(2 * 10 * 4 * 128 * 2 * 1000)
    expect(estimateKvBytes({ 'general.architecture': 'a' }, 1000)).toBeNull()
    expect(estimateKvBytes(undefined, 1000)).toBeNull()
  })

  it('parses /api/ps and classifies GPU use', () => {
    const ps = parsePs({
      models: [
        { name: 'a', size: 100, size_vram: 100, context_length: 4096, expires_at: '2026-10-02T10:00:00Z' },
        { name: 'b', size: 100, size_vram: 40 },
        { name: 'c', size: 100, size_vram: 0 },
      ],
    })
    expect(ps[0]).toMatchObject({ name: 'a', contextLength: 4096 })
    expect(ps.map(gpuStatus)).toEqual([
      { kind: 'gpu', pct: 100 },
      { kind: 'split', pct: 40 },
      { kind: 'cpu', pct: 0 },
    ])
  })

  it('parses pull progress lines and drains NDJSON buffers', () => {
    expect(parsePullLine('{"status":"pulling abc","digest":"sha256:abc","total":100,"completed":40}')).toEqual({
      status: 'pulling abc',
      digest: 'sha256:abc',
      total: 100,
      completed: 40,
      error: undefined,
    })
    expect(parsePullLine('{"error":"boom"}')).toMatchObject({ error: 'boom' })
    expect(parsePullLine('not json')).toBeNull()
    expect(parsePullLine('{"x":1}')).toBeNull()
    expect(drainNdjson('{"a":1}\n{"b":2}\n{"c"')).toEqual({ lines: ['{"a":1}', '{"b":2}'], rest: '{"c"' })
  })

  it('sums manifest layer sizes', () => {
    expect(sumManifestBytes({ layers: [{ size: 100 }, { size: 50 }] })).toBe(150)
    expect(sumManifestBytes({ layers: [] })).toBeNull()
    expect(sumManifestBytes({ layers: [{ size: 'x' }] })).toBeNull()
    expect(sumManifestBytes(null)).toBeNull()
  })

  it('builds registry manifest URLs, adding the library namespace', () => {
    expect(manifestUrl('qwen3.5:9b')).toBe('https://registry.ollama.ai/v2/library/qwen3.5/manifests/9b')
    expect(manifestUrl('someone/model')).toBe('https://registry.ollama.ai/v2/someone/model/manifests/latest')
    expect(manifestUrl('../x')).toBeNull()
  })
})

describe('local server fixtures', () => {
  it('LM Studio: loaded window wins over the ceiling; embeddings dropped', () => {
    const models = parseLmStudioModels({
      models: [
        {
          key: 'qwen/qwen3-8b',
          type: 'llm',
          size_bytes: 5e9,
          max_context_length: 40960,
          loaded_instances: [{ config: { context_length: 8192 } }],
        },
        { key: 'other', type: 'llm', max_context_length: 4096, loaded_instances: [] },
        { key: 'embed', type: 'embedding' },
      ],
    })
    expect(models).toEqual([
      { id: 'qwen/qwen3-8b', contextTokens: 8192, sizeBytes: 5e9, loaded: true },
      { id: 'other', contextTokens: 4096, sizeBytes: undefined, loaded: false },
    ])
  })

  it('llama.cpp: n_ctx from /props, n_ctx_train from /v1/models', () => {
    expect(parseLlamaCppProps({ default_generation_settings: { n_ctx: 4096 } })).toBe(4096)
    expect(parseLlamaCppProps({})).toBeNull()
    const r = parseOpenAiModelsMeta({ data: [{ id: 'm.gguf', meta: { n_ctx_train: 32768 } }] })
    expect(r.vllm).toBe(false)
    expect(r.models[0]).toMatchObject({ id: 'm.gguf', contextTokens: 32768 })
  })

  it('vLLM: max_model_len marks the server', () => {
    const r = parseOpenAiModelsMeta({ data: [{ id: 'meta/llama', max_model_len: 16384 }] })
    expect(r.vllm).toBe(true)
    expect(r.models[0].contextTokens).toBe(16384)
  })
})

describe('computeNumCtx', () => {
  it('rounds prompt + reserves up to 1024', () => {
    expect(computeNumCtx({ promptTokens: 5000, outputReserve: 2000 })).toBe(7168)
    expect(computeNumCtx({ promptTokens: 1024, outputReserve: 0 })).toBe(1024)
    expect(computeNumCtx({ promptTokens: 1025, outputReserve: 0, thinkReserve: 100 })).toBe(2048)
  })
  it('clamps to the model maximum and never returns below one step', () => {
    expect(computeNumCtx({ promptTokens: 100_000, outputReserve: 8192, modelMax: 32768 })).toBe(32768)
    expect(computeNumCtx({ promptTokens: 0, outputReserve: 0 })).toBe(1024)
    expect(computeNumCtx({ promptTokens: -5, outputReserve: -5 })).toBe(1024)
  })
  it('ollamaNumCtx: configured window wins, else sized from the request but at least 8192', () => {
    expect(ollamaNumCtx({ contextTokens: 16384 }, 1e6, 8192)).toBe(16384)
    expect(ollamaNumCtx({}, 30, 100)).toBe(8192)
    expect(ollamaNumCtx({}, 3 * 20_000, 8192)).toBe(28672)
    expect(estimateTokens(10)).toBe(4)
  })
})

describe('input truncation', () => {
  it('flags a prompt that filled the window (within the margin)', () => {
    expect(inputWasTruncated({ prompt_eval_count: 4096 }, 4096)).toBe(true)
    expect(inputWasTruncated({ prompt_eval_count: 4040 }, 4096)).toBe(true)
    expect(inputWasTruncated({ prompt_eval_count: 4000 }, 4096)).toBe(false)
    expect(inputWasTruncated({}, 4096)).toBe(false)
    expect(inputWasTruncated({ prompt_eval_count: 9999 }, undefined)).toBe(false)
  })
  it('reads num_ctx back out of a request body', () => {
    expect(numCtxOfBody(JSON.stringify({ options: { num_ctx: 8192 } }))).toBe(8192)
    expect(numCtxOfBody('nope')).toBeUndefined()
    expect(numCtxOfBody(undefined)).toBeUndefined()
  })
})

describe('model tags', () => {
  it('accepts library, namespaced and tagged names', () => {
    for (const t of ['qwen3.5:9b', 'gpt-oss:20b', 'mistral-small3.2', 'user/model:q4_K_M'.toLowerCase()]) {
      expect(isValidModelTag(t)).toBe(true)
    }
  })
  it('rejects anything that could escape a body or URL', () => {
    for (const t of ['', 'A:B', 'a b', 'a:b:c', '../x', 'a//b', '/a', 'a;rm', 'a?x=1', 'a\n', 'a:', 5, null, 'x'.repeat(201)]) {
      expect(isValidModelTag(t)).toBe(false)
    }
  })
})

describe('OLLAMA_SHORTLIST', () => {
  it('has valid, unique tags and sane numbers', () => {
    const tags = OLLAMA_SHORTLIST.map((m) => m.tag)
    expect(new Set(tags).size).toBe(tags.length)
    for (const m of OLLAMA_SHORTLIST) {
      expect(isValidModelTag(m.tag)).toBe(true)
      expect(manifestUrl(m.tag)).not.toBeNull()
      expect(m.approxBytes).toBeGreaterThan(1e9)
      expect(m.contextTokens).toBeGreaterThanOrEqual(32_000)
      expect(m.minRamGB).toBeGreaterThan(0)
      expect(m.verifiedAt).toBe('2026-10-02')
    }
    expect(tags).not.toContain('phi4')
  })
})
