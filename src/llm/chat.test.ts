import { describe, it, expect } from 'vitest'
import { buildChatRequest, parseChatResponse, type ChatMessage, type ToolDef } from './chat'
import { PROVIDERS, type PaperPart } from './providers'
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

const bodyOf = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>
const PAPER: PaperPart = { kind: 'text', text: 'the paper text' }

const TOOLS: ToolDef[] = [
  {
    name: 'search_paper',
    description: 'search',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
]

describe('buildChatRequest / parseChatResponse round-trip per wire format', () => {
  it('anthropic: tool_use call round-trips through tool_result', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }]
    const req = buildChatRequest(cfg('anthropic'), 'sys', messages, TOOLS, { paper: PAPER })
    const body = bodyOf(req)
    expect(body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }])
    expect(body.tools).toEqual([
      { name: 'search_paper', description: 'search', input_schema: TOOLS[0].parameters },
    ])
    const userMsg = body.messages[0]
    expect(userMsg.content[0]).toMatchObject({ type: 'text', text: 'the paper text' })
    expect(userMsg.content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(userMsg.content[1]).toEqual({ type: 'text', text: 'go' })

    // Simulate the model's tool_use response.
    const response = {
      content: [{ type: 'tool_use', id: 'call_1', name: 'search_paper', input: { query: 'sample size' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const parsed = parseChatResponse('anthropic', response)
    expect(parsed.toolCalls).toEqual([{ id: 'call_1', name: 'search_paper', args: { query: 'sample size' } }])
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 5 })

    messages.push({ role: 'assistant', toolCalls: parsed.toolCalls, raw: parsed.raw })
    messages.push({ role: 'tool', toolCallId: 'call_1', name: 'search_paper', content: 'found on page 3' })
    const req2 = buildChatRequest(cfg('anthropic'), 'sys', messages, TOOLS, { paper: PAPER })
    const body2 = bodyOf(req2)
    expect(body2.messages[1]).toEqual({ role: 'assistant', content: response.content })
    expect(body2.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'found on page 3' }] }],
    })
  })

  it('google: functionCall round-trips through functionResponse', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }]
    const req = buildChatRequest(cfg('google'), 'sys', messages, TOOLS, { paper: PAPER })
    const body = bodyOf(req)
    expect(body.tools).toEqual([
      { functionDeclarations: [{ name: 'search_paper', description: 'search', parameters: TOOLS[0].parameters }] },
    ])
    expect(body.contents[0].parts[0]).toEqual({ text: 'the paper text' })
    expect(body.contents[0].parts[1]).toEqual({ text: 'go' })

    const response = {
      candidates: [
        {
          content: { parts: [{ functionCall: { name: 'search_paper', args: { query: 'sample size' } } }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 },
    }
    const parsed = parseChatResponse('google', response)
    expect(parsed.toolCalls).toEqual([{ id: 'call_0', name: 'search_paper', args: { query: 'sample size' } }])
    expect(parsed.usage).toEqual({ inputTokens: 20, outputTokens: 8 })

    messages.push({ role: 'assistant', toolCalls: parsed.toolCalls, raw: parsed.raw })
    messages.push({ role: 'tool', toolCallId: 'call_0', name: 'search_paper', content: 'found on page 3' })
    const req2 = buildChatRequest(cfg('google'), 'sys', messages, TOOLS, { paper: PAPER })
    const body2 = bodyOf(req2)
    expect(body2.contents[1]).toEqual({ role: 'model', parts: response.candidates[0].content.parts })
    expect(body2.contents[2]).toEqual({
      role: 'function',
      parts: [{ functionResponse: { name: 'search_paper', response: { content: 'found on page 3' } } }],
    })
  })

  it('openai-shaped: tool_calls round-trips through role "tool"', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }]
    const req = buildChatRequest(cfg('openai'), 'sys', messages, TOOLS, { paper: PAPER })
    const body = bodyOf(req)
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'search_paper', description: 'search', parameters: TOOLS[0].parameters } },
    ])
    // system + user (paper is a plain-text kind, wrapped as a content-parts array since a tool run follows)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.messages[1].content[0]).toEqual({ type: 'text', text: 'the paper text' })
    expect(body.messages[1].content[1]).toEqual({ type: 'text', text: 'go' })

    const response = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'search_paper', arguments: '{"query":"sample size"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 15, completion_tokens: 6 },
    }
    const parsed = parseChatResponse('openai', response)
    expect(parsed.toolCalls).toEqual([{ id: 'call_1', name: 'search_paper', args: { query: 'sample size' } }])
    expect(parsed.usage).toEqual({ inputTokens: 15, outputTokens: 6 })

    messages.push({ role: 'assistant', toolCalls: parsed.toolCalls, raw: parsed.raw })
    messages.push({ role: 'tool', toolCallId: 'call_1', name: 'search_paper', content: 'found on page 3' })
    const req2 = buildChatRequest(cfg('openai'), 'sys', messages, TOOLS, { paper: PAPER })
    const body2 = bodyOf(req2)
    expect(body2.messages[2]).toEqual(response.choices[0].message)
    expect(body2.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'found on page 3' })
  })

  it('handles a malformed tool-call arguments string without throwing', () => {
    const response = {
      choices: [
        { message: { tool_calls: [{ id: 'x', function: { name: 'search_paper', arguments: '{not json' } }] } },
      ],
    }
    const parsed = parseChatResponse('openai', response)
    expect(parsed.toolCalls[0].args).toBe('{not json')
  })

  it('parseChatResponse never throws on garbage input', () => {
    for (const p of ['anthropic', 'google', 'openai'] as const) {
      expect(parseChatResponse(p, null).text).toBe('')
      expect(parseChatResponse(p, 'nope').toolCalls).toEqual([])
      expect(parseChatResponse(p, {}).truncated).toBe(false)
    }
  })
})
