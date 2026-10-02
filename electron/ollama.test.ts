import { describe, it, expect } from 'vitest'
import { checkBaseUrl, registerOllamaHandlers, type OllamaDeps } from './ollama'

type Handler = (e: unknown, ...args: any[]) => Promise<any>

function setup(routes: Record<string, () => Response>) {
  const handlers = new Map<string, Handler>()
  const sent: unknown[] = []
  const urls: string[] = []
  const deps: OllamaDeps = {
    fetch: async (url) => {
      urls.push(url)
      const route = Object.entries(routes).find(([k]) => url.endsWith(k))
      if (!route) throw new Error('connect ECONNREFUSED')
      return route[1]()
    },
    send: (_c, p) => sent.push(p),
  }
  registerOllamaHandlers({ handle: (c: string, h: Handler) => void handlers.set(c, h), on: () => undefined } as never, deps)
  return { call: (c: string, ...a: unknown[]) => handlers.get(c)!(null, ...a), sent, urls }
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })

describe('checkBaseUrl', () => {
  it('reduces to the origin and flags local hosts', () => {
    expect(checkBaseUrl('http://localhost:11434/api')).toEqual({ ok: true, origin: 'http://localhost:11434', isLocal: true })
    for (const h of ['http://127.0.0.1:1', 'http://192.168.1.5:11434', 'http://[::1]:1', 'http://box.local:1']) {
      expect(checkBaseUrl(h)).toMatchObject({ ok: true, isLocal: true })
    }
    expect(checkBaseUrl('https://gpu.example.com')).toMatchObject({ ok: true, isLocal: false })
    expect(checkBaseUrl('http://8.8.8.8:1')).toMatchObject({ ok: true, isLocal: false })
  })
  it('rejects bad schemes, credentials and garbage', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://x', 'http://u:p@localhost', 'nonsense', undefined]) {
      expect(checkBaseUrl(bad).ok).toBe(false)
    }
  })
})

describe('ollama handlers', () => {
  it('lists models and reports isLocal', async () => {
    const t = setup({ '/api/tags': () => json({ models: [{ name: 'a:1', size: 5 }] }) })
    expect(await t.call('ollama:list', 'http://localhost:11434')).toMatchObject({ ok: true, isLocal: true, models: [{ name: 'a:1' }] })
  })

  it('reports an unreachable server instead of throwing', async () => {
    const t = setup({})
    expect(await t.call('ollama:version', 'http://localhost:11434')).toMatchObject({ ok: false, error: expect.stringContaining("Can't reach") })
  })

  it('refuses invalid URLs and model tags before any request', async () => {
    const t = setup({ '/api/show': () => json({}) })
    expect((await t.call('ollama:show', 'file:///x', 'a')).ok).toBe(false)
    expect(await t.call('ollama:show', 'http://localhost:11434', '../evil')).toEqual({ ok: false, error: 'Invalid model name.' })
    expect(await t.call('ollama:delete', 'http://localhost:11434', 'A B')).toEqual({ ok: false, error: 'Invalid model name.' })
    expect(t.urls).toEqual([])
  })

  it('show returns context, capabilities and KV estimate', async () => {
    const t = setup({
      '/api/show': () =>
        json({
          capabilities: ['tools'],
          model_info: { 'general.architecture': 'q', 'q.context_length': 32768, 'q.block_count': 2, 'q.attention.head_count_kv': 1, 'q.attention.key_length': 4 },
        }),
    })
    const r = await t.call('ollama:show', 'http://localhost:11434', 'q:1', 10)
    expect(r.info).toEqual({ capabilities: ['tools'], contextTokens: 32768, thinking: null, kvBytes: 2 * 2 * 1 * 4 * 2 * 10 })
  })

  it('manifestSize sums layers; 404 gives null bytes', async () => {
    const ok = setup({ '/manifests/9b': () => json({ layers: [{ size: 3 }, { size: 4 }] }) })
    expect(await ok.call('ollama:manifestSize', 'qwen3.5:9b')).toEqual({ ok: true, bytes: 7 })
    const missing = setup({ '/manifests/9b': () => json({}, 404) })
    expect(await missing.call('ollama:manifestSize', 'qwen3.5:9b')).toEqual({ ok: true, bytes: null })
  })

  it('pull forwards progress and succeeds only on "success"', async () => {
    const lines = ['{"status":"pulling x","digest":"d","total":10,"completed":5}', '{"status":"success"}'].join('\n') + '\n'
    const t = setup({ '/api/pull': () => new Response(lines) })
    expect(await t.call('ollama:pull', 'r1', 'http://localhost:11434', 'a:1')).toEqual({ ok: true })
    expect(t.sent).toMatchObject([{ requestId: 'r1', total: 10, completed: 5 }, { requestId: 'r1', status: 'success' }])

    const cut = setup({ '/api/pull': () => new Response('{"status":"pulling x"}\n') })
    expect((await cut.call('ollama:pull', 'r2', 'http://localhost:11434', 'a:1')).ok).toBe(false)
    const err = setup({ '/api/pull': () => new Response('{"error":"disk full"}\n') })
    expect(await err.call('ollama:pull', 'r3', 'http://localhost:11434', 'a:1')).toEqual({ ok: false, error: 'disk full' })
  })
})

describe('localserver:discover', () => {
  it('detects Ollama and marks loaded models', async () => {
    const t = setup({
      '/api/version': () => json({ version: '0.35.0' }),
      '/api/tags': () => json({ models: [{ name: 'a:1', size: 5 }, { name: 'b:1', size: 6 }] }),
      '/api/ps': () => json({ models: [{ name: 'a:1', size: 5, size_vram: 5, context_length: 4096 }] }),
    })
    const r = await t.call('localserver:discover', 'http://localhost:11434')
    expect(r).toMatchObject({ ok: true, kind: 'ollama', isLocal: true })
    expect(r.models).toEqual([
      { id: 'a:1', sizeBytes: 5, loaded: true, contextTokens: 4096 },
      { id: 'b:1', sizeBytes: 6, loaded: false, contextTokens: undefined },
    ])
  })

  it('detects LM Studio, llama.cpp, vLLM and unknown OpenAI-style servers', async () => {
    const lm = setup({ '/api/v1/models': () => json({ models: [{ key: 'm', type: 'llm', max_context_length: 8192 }] }) })
    expect((await lm.call('localserver:discover', 'http://localhost:1234')).kind).toBe('lmstudio')

    const llama = setup({
      '/props': () => json({ default_generation_settings: { n_ctx: 4096 } }),
      '/v1/models': () => json({ data: [{ id: 'g.gguf', meta: { n_ctx_train: 32768 } }] }),
    })
    const l = await llama.call('localserver:discover', 'http://localhost:8080/v1')
    expect(l).toMatchObject({ kind: 'llamacpp', models: [{ id: 'g.gguf', contextTokens: 4096 }] })

    const vllm = setup({ '/v1/models': () => json({ data: [{ id: 'm', max_model_len: 16384 }] }) })
    expect(await vllm.call('localserver:discover', 'http://localhost:8000')).toMatchObject({ kind: 'vllm' })

    const other = setup({ '/v1/models': () => json({ data: [{ id: 'm' }] }) })
    expect((await other.call('localserver:discover', 'http://localhost:9')).kind).toBe('unknown')
    expect((await setup({}).call('localserver:discover', 'http://localhost:9')).ok).toBe(false)
  })
})
