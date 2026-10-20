import { describe, it, expect } from 'vitest'
import { buildChatRequest, parseChatResponse, type ChatMessage, type ToolDef } from './chat'
import { PROVIDERS, buildRequest, extractError, extractText, wasTruncated } from './providers'
import { buildModelsRequest, parseModelsResponse } from './models'
import { API_KEY_SENTINEL } from './types'
import type { LlmConfig } from './types'

const cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  id: 'o1',
  name: 'local',
  provider: 'ollama',
  baseUrl: PROVIDERS.ollama.defaultBaseUrl,
  model: 'qwen3.5:9b',
  attach: 'text',
  hasKey: false,
  noKey: true,
  ...over,
})
const bodyOf = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>
const TOOLS: ToolDef[] = [{ name: 'search_paper', description: 'search', parameters: { type: 'object' } }]

describe('ollama buildRequest', () => {
  it('posts to native /api/chat with an explicit num_ctx, no streaming, think off', () => {
    const req = buildRequest(cfg({ contextTokens: 16384 }), 'sys', { kind: 'text', text: 'paper' }, { maxTokens: 1000 })
    expect(req.url).toBe('http://localhost:11434/api/chat')
    expect(req.headers.Authorization).toBe(`Bearer ${API_KEY_SENTINEL}`)
    expect(bodyOf(req)).toEqual({
      model: 'qwen3.5:9b',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'paper' },
      ],
      stream: false,
      keep_alive: '10m',
      think: false,
      options: { num_ctx: 16384, temperature: 0, num_predict: 1000 },
    })
  })

  it('computes num_ctx from the request size when the target has none, never leaving it to the server', () => {
    const small = bodyOf(buildRequest(cfg(), 's', { kind: 'text', text: 'p' }))
    expect(small.options.num_ctx).toBe(9216) // 8192 reply reserve + a tiny prompt, rounded up to 1024
    const big = bodyOf(buildRequest(cfg(), 's', { kind: 'text', text: 'x'.repeat(90_000) }))
    expect(big.options.num_ctx).toBeGreaterThanOrEqual(30_000 + 8192)
    expect(big.options.num_ctx % 1024).toBe(0)
  })

  it('passes a reasoning level through as think', () => {
    expect(bodyOf(buildRequest(cfg({ reasoningEffort: 'high' }), 's', { kind: 'text', text: 'p' })).think).toBe('high')
    expect(bodyOf(buildRequest(cfg({ reasoningEffort: 'on' }), 's', { kind: 'text', text: 'p' })).think).toBe(true)
  })

  it('refuses a PDF', () => {
    expect(() => buildRequest(cfg(), 's', { kind: 'pdf', base64: 'x', filename: 'a.pdf' })).toThrow(/PDF/)
  })
})

describe('ollama agent mode', () => {
  it('sends tools in Ollama format and round-trips a tool call', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }]
    const req = buildChatRequest(cfg(), 'sys', messages, TOOLS, { paper: { kind: 'text', text: 'the paper' } })
    const body = bodyOf(req)
    expect(req.url).toBe('http://localhost:11434/api/chat')
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'search_paper', description: 'search', parameters: { type: 'object' } } },
    ])
    expect(body.messages[1]).toEqual({ role: 'user', content: 'the paper\n\ngo' })
    expect(body.options.num_ctx).toBeGreaterThan(0)

    const response = {
      model: 'qwen3.5:9b',
      message: {
        role: 'assistant',
        content: '',
        thinking: 'hmm',
        tool_calls: [{ function: { name: 'search_paper', arguments: { query: 'n' } } }],
      },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 120,
      eval_count: 30,
    }
    const parsed = parseChatResponse('ollama', response, req)
    expect(parsed.toolCalls).toEqual([{ id: 'call_0', name: 'search_paper', args: { query: 'n' } }])
    expect(parsed.usage).toEqual({ inputTokens: 120, outputTokens: 30 })
    expect(parsed.inputTruncated).toBe(false)

    messages.push({ role: 'assistant', toolCalls: parsed.toolCalls, raw: parsed.raw })
    messages.push({ role: 'tool', toolCallId: 'call_0', name: 'search_paper', content: 'found' })
    const body2 = bodyOf(buildChatRequest(cfg(), 'sys', messages, TOOLS, { paper: { kind: 'text', text: 'the paper' } }))
    expect(body2.messages[2]).toEqual(response.message)
    expect(body2.messages[3]).toEqual({ role: 'tool', tool_name: 'search_paper', content: 'found' })
  })

  it('rebuilds an assistant turn without raw with object arguments', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', toolCalls: [{ id: 'c', name: 'search_paper', args: { q: 1 } }] },
    ]
    const body = bodyOf(buildChatRequest(cfg(), 's', messages, TOOLS))
    expect(body.messages[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'search_paper', arguments: { q: 1 } } }],
    })
  })

  it('flags input truncation when the prompt filled num_ctx, and passes without a request', () => {
    const req = buildChatRequest(cfg({ contextTokens: 4096 }), 's', [{ role: 'user', content: 'x' }], [])
    const json = { message: { role: 'assistant', content: '{}' }, done: true, prompt_eval_count: 4096, eval_count: 5 }
    expect(parseChatResponse('ollama', json, req).inputTruncated).toBe(true)
    expect(parseChatResponse('ollama', { ...json, prompt_eval_count: 1000 }, req).inputTruncated).toBe(false)
    expect(parseChatResponse('ollama', json).inputTruncated).toBe(false)
  })
})

describe('ollama response helpers', () => {
  const json = { message: { role: 'assistant', content: 'hi' }, done: true, done_reason: 'length' }
  it('reads text, truncation and errors', () => {
    expect(extractText('ollama', json)).toBe('hi')
    expect(extractText('ollama', {})).toBe('')
    expect(wasTruncated('ollama', json)).toBe(true)
    expect(wasTruncated('ollama', { ...json, done_reason: 'stop' })).toBe(false)
    expect(extractError('ollama', 404, '{"error":"model \'x\' not found"}')).toBe(
      "Ollama (local): model 'x' not found — pull the model first",
    )
    expect(extractError('ollama', 500, '{"error":"boom"}')).toBe('Ollama (local): boom')
  })
})

describe('ollama model listing', () => {
  it('lists via GET /api/tags and parses names with sizes in the label', () => {
    const req = buildModelsRequest(cfg())!
    expect(req.url).toBe('http://localhost:11434/api/tags')
    expect(req.method).toBe('GET')
    const page = parseModelsResponse('ollama', {
      models: [{ name: 'qwen3.5:9b', details: { parameter_size: '9B' } }, { name: 'plain' }],
    })
    expect(page.models).toEqual([
      { id: 'qwen3.5:9b', label: 'qwen3.5:9b (9B)', reasoning: null },
      { id: 'plain', label: 'plain', reasoning: null },
    ])
  })
})
