import { describe, it, expect } from 'vitest'
import { buildRequest, extractError, extractText, join, PROVIDERS, PROVIDER_LIST } from './providers'
import type { PaperPart } from './providers'
import { API_KEY_SENTINEL } from './types'
import type { LlmConfig, Provider } from './types'

const REAL_KEY = 'sk-do-not-leak-me'

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

const TEXT: PaperPart = { kind: 'text', text: 'the paper' }
const PDF: PaperPart = { kind: 'pdf', base64: 'QkFTRTY0', filename: 'paper.pdf' }

const bodyOf = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>

describe('join', () => {
  it('appends the path to a bare base', () => {
    expect(join('http://localhost:1234', '/v1/chat/completions')).toBe(
      'http://localhost:1234/v1/chat/completions',
    )
    expect(join('http://localhost:1234/', '/v1/chat/completions')).toBe(
      'http://localhost:1234/v1/chat/completions',
    )
  })

  it('does not duplicate a suffix the user already typed', () => {
    expect(join('http://localhost:1234/v1', '/v1/chat/completions')).toBe(
      'http://localhost:1234/v1/chat/completions',
    )
    expect(join('http://localhost:1234/v1/', '/v1/chat/completions')).toBe(
      'http://localhost:1234/v1/chat/completions',
    )
    expect(join('http://x/v1/chat/completions', '/v1/chat/completions')).toBe(
      'http://x/v1/chat/completions',
    )
  })

  it('keeps a path prefix that is part of the deployment, not of the API', () => {
    // A reverse-proxied server under a subpath must survive intact.
    expect(join('https://host/llm', '/v1/chat/completions')).toBe(
      'https://host/llm/v1/chat/completions',
    )
    // "v1" only counts as the API root when it is a whole trailing segment.
    expect(join('https://host/apiv1', '/v1/chat/completions')).toBe(
      'https://host/apiv1/v1/chat/completions',
    )
  })
})

describe('PROVIDERS', () => {
  it('lists every provider once, with an editable base only where the user must supply one', () => {
    expect(PROVIDER_LIST.map((p) => p.id)).toEqual([
      'anthropic',
      'openai',
      'openrouter',
      'openai-compatible',
    ])
    for (const info of PROVIDER_LIST) {
      expect(info.editableBaseUrl).toBe(info.defaultBaseUrl === '')
    }
    expect(PROVIDERS['openai-compatible'].editableBaseUrl).toBe(true)
    expect(PROVIDERS['openai-compatible'].supportsPdf).toBe(false)
    expect(PROVIDERS.anthropic.supportsPdf).toBe(true)
  })
})

describe('buildRequest: url and auth', () => {
  it('targets the documented endpoint of each provider', () => {
    expect(buildRequest(cfg('anthropic'), 's', TEXT).url).toBe('https://api.anthropic.com/v1/messages')
    expect(buildRequest(cfg('openai'), 's', TEXT).url).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
    expect(buildRequest(cfg('openrouter'), 's', TEXT).url).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    )
    expect(buildRequest(cfg('openai-compatible', { baseUrl: 'http://localhost:1234/v1' }), 's', TEXT).url).toBe(
      'http://localhost:1234/v1/chat/completions',
    )
  })

  it('authenticates the way each provider expects', () => {
    expect(buildRequest(cfg('anthropic'), 's', TEXT).headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': API_KEY_SENTINEL,
      'anthropic-version': '2023-06-01',
    })
    for (const p of ['openai', 'openrouter', 'openai-compatible'] as const) {
      const headers = buildRequest(cfg(p, { baseUrl: 'http://x' }), 's', TEXT).headers
      expect(headers.Authorization).toBe(`Bearer ${API_KEY_SENTINEL}`)
      expect(headers['content-type']).toBe('application/json')
    }
  })

  it('carries the sentinel and never a key — the renderer has none to leak', () => {
    for (const p of PROVIDER_LIST) {
      const req = buildRequest(cfg(p.id, { baseUrl: 'http://x' }), 'system', PDF)
      const serialized = JSON.stringify(req)
      expect(serialized).toContain(API_KEY_SENTINEL)
      expect(serialized).not.toContain(REAL_KEY)
      // Nothing that looks like a bearer/api key beyond the placeholder itself.
      const auth = Object.entries(req.headers)
        .filter(([k]) => /authorization|api-key/i.test(k))
        .map(([, v]) => v)
      expect(auth).toHaveLength(1)
      expect(auth[0]).toContain(API_KEY_SENTINEL)
      expect(auth[0].replace(API_KEY_SENTINEL, '')).not.toMatch(/sk-|[A-Za-z0-9_-]{20,}/)
    }
  })
})

describe('buildRequest: body', () => {
  it('sends extracted text as a plain user message everywhere', () => {
    const anthropic = bodyOf(buildRequest(cfg('anthropic'), 'sys', TEXT))
    expect(anthropic).toMatchObject({
      model: 'the-model',
      max_tokens: 4096,
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'the paper' }] }],
    })

    const openai = bodyOf(buildRequest(cfg('openai'), 'sys', TEXT))
    expect(openai).toMatchObject({
      model: 'the-model',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'the paper' },
      ],
    })
    // The system prompt is a message, not a top-level field, on this family.
    expect(openai.system).toBeUndefined()
  })

  it('attaches a PDF in the provider-native shape', () => {
    const anthropic = bodyOf(buildRequest(cfg('anthropic'), 'sys', PDF))
    const parts = anthropic.messages[0].content
    expect(parts[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'QkFTRTY0' },
    })
    expect(parts[1].type).toBe('text')

    const openai = bodyOf(buildRequest(cfg('openai'), 'sys', PDF))
    const oparts = openai.messages[1].content
    expect(oparts[0]).toEqual({
      type: 'file',
      file: { filename: 'paper.pdf', file_data: 'data:application/pdf;base64,QkFTRTY0' },
    })
  })

  it('honours a maxTokens override', () => {
    expect(bodyOf(buildRequest(cfg('anthropic'), 's', TEXT, { maxTokens: 100 })).max_tokens).toBe(100)
    expect(bodyOf(buildRequest(cfg('openrouter'), 's', TEXT, { maxTokens: 100 })).max_tokens).toBe(100)
  })
})

describe('extractText', () => {
  it('concatenates anthropic text blocks and ignores the rest', () => {
    const json = {
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: '{"fields":' },
        { type: 'text', text: '[]}' },
      ],
    }
    expect(extractText('anthropic', json)).toBe('{"fields":[]}')
  })

  it('reads openai/openrouter content whether it is a string or a parts array', () => {
    expect(extractText('openai', { choices: [{ message: { content: 'hello' } }] })).toBe('hello')
    expect(
      extractText('openrouter', {
        choices: [{ message: { content: [{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }] } }],
      }),
    ).toBe('hello')
    expect(extractText('openai-compatible', { choices: [{ message: { content: 'hi' } }] })).toBe('hi')
  })

  it('returns "" for anything unexpected instead of throwing', () => {
    for (const p of PROVIDER_LIST.map((i) => i.id)) {
      expect(extractText(p, null)).toBe('')
      expect(extractText(p, 'not json at all')).toBe('')
      expect(extractText(p, {})).toBe('')
      expect(extractText(p, { choices: [], content: [] })).toBe('')
      expect(extractText(p, { choices: [{}], content: [{ type: 'text' }] })).toBe('')
    }
  })
})

describe('extractError', () => {
  it('surfaces the provider message when there is one', () => {
    expect(extractError('anthropic', 400, '{"error":{"message":"credit balance is too low"}}')).toContain(
      'credit balance is too low',
    )
    expect(extractError('openai', 401, '{"error":{"type":"auth","message":"Invalid API key"}}')).toContain(
      'Invalid API key',
    )
    // Flattened variants that OpenAI-compatible servers like to send.
    expect(extractError('openai-compatible', 500, '{"error":"model not loaded"}')).toContain(
      'model not loaded',
    )
    expect(extractError('openrouter', 429, '{"message":"rate limited"}')).toContain('rate limited')
  })

  it('falls back to the status and a truncated body when the body is not a usable error', () => {
    const html = extractError('openai-compatible', 502, '<html><body>Bad Gateway</body></html>')
    expect(html).toContain('502')
    expect(html).toContain('Bad Gateway')

    expect(extractError('openai', 500, '')).toContain('500')
    expect(extractError('openai', 500, '{}')).toContain('500')

    const long = extractError('anthropic', 500, 'x'.repeat(5000))
    expect(long.length).toBeLessThan(300)
    expect(long).toContain('500')
  })
})
