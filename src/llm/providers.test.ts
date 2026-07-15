import { describe, it, expect } from 'vitest'
import {
  buildRequest,
  extractError,
  extractText,
  wasTruncated,
  join,
  PROVIDERS,
  PROVIDER_LIST,
} from './providers'
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
      'google',
      'openrouter',
      'groq',
      'mistral',
      'deepseek',
      'xai',
      'openai-compatible',
    ])
    for (const info of PROVIDER_LIST) {
      expect(info.editableBaseUrl).toBe(info.defaultBaseUrl === '')
    }
    expect(PROVIDERS['openai-compatible'].editableBaseUrl).toBe(true)
    expect(PROVIDERS['openai-compatible'].supportsPdf).toBe(false)
    expect(PROVIDERS.anthropic.supportsPdf).toBe(true)
  })

  it('only claims inline-PDF support where a single request can actually carry one', () => {
    // Anthropic, OpenAI, Google and OpenRouter accept base64 PDF bytes in the
    // same request as the prompt. The rest either have no file input at all
    // (Groq, DeepSeek), only take a fetchable URL rather than inline bytes
    // (Mistral), or require an upload-then-reference flow this app does not
    // implement (xAI) — see the comments in providers.ts for the source per
    // provider. Getting this wrong would let the UI offer a PDF option that
    // silently fails against the real API.
    expect(PROVIDERS.anthropic.supportsPdf).toBe(true)
    expect(PROVIDERS.openai.supportsPdf).toBe(true)
    expect(PROVIDERS.google.supportsPdf).toBe(true)
    expect(PROVIDERS.openrouter.supportsPdf).toBe(true)
    expect(PROVIDERS.groq.supportsPdf).toBe(false)
    expect(PROVIDERS.mistral.supportsPdf).toBe(false)
    expect(PROVIDERS.deepseek.supportsPdf).toBe(false)
    expect(PROVIDERS.xai.supportsPdf).toBe(false)
  })

  it('picks the output-length parameter each provider currently documents', () => {
    // This is the bug report this file exists to prevent from recurring: OpenAI
    // (and xAI, and Groq, all of which have reasoning-model variants) now
    // reject the old `max_tokens` name outright. OpenRouter, Mistral, DeepSeek
    // and generic OpenAI-compatible servers still expect it.
    expect(PROVIDERS.openai.tokenParam).toBe('max_completion_tokens')
    expect(PROVIDERS.xai.tokenParam).toBe('max_completion_tokens')
    expect(PROVIDERS.groq.tokenParam).toBe('max_completion_tokens')
    expect(PROVIDERS.openrouter.tokenParam).toBe('max_tokens')
    expect(PROVIDERS.mistral.tokenParam).toBe('max_tokens')
    expect(PROVIDERS.deepseek.tokenParam).toBe('max_tokens')
    expect(PROVIDERS['openai-compatible'].tokenParam).toBe('max_tokens')
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
    expect(buildRequest(cfg('groq'), 's', TEXT).url).toBe(
      'https://api.groq.com/openai/v1/chat/completions',
    )
    expect(buildRequest(cfg('mistral'), 's', TEXT).url).toBe(
      'https://api.mistral.ai/v1/chat/completions',
    )
    expect(buildRequest(cfg('deepseek'), 's', TEXT).url).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    )
    expect(buildRequest(cfg('xai'), 's', TEXT).url).toBe('https://api.x.ai/v1/chat/completions')
    expect(buildRequest(cfg('openai-compatible', { baseUrl: 'http://localhost:1234/v1' }), 's', TEXT).url).toBe(
      'http://localhost:1234/v1/chat/completions',
    )
  })

  it('puts the model in the URL path for Google, not the body', () => {
    const req = buildRequest(cfg('google', { model: 'gemini-2.5-pro' }), 's', TEXT)
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    )
    expect(bodyOf(req).model).toBeUndefined()
  })

  it('authenticates the way each provider expects', () => {
    expect(buildRequest(cfg('anthropic'), 's', TEXT).headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': API_KEY_SENTINEL,
      'anthropic-version': '2023-06-01',
    })
    expect(buildRequest(cfg('google'), 's', TEXT).headers).toEqual({
      'content-type': 'application/json',
      'x-goog-api-key': API_KEY_SENTINEL,
    })
    for (const p of [
      'openai',
      'openrouter',
      'groq',
      'mistral',
      'deepseek',
      'xai',
      'openai-compatible',
    ] as const) {
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
      max_tokens: 8192,
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'the paper' }] }],
    })

    // OpenAI's own error, verbatim, is what makes this the regression test for
    // the reported bug: "Unsupported parameter: 'max_tokens' is not supported
    // with this model. Use 'max_completion_tokens' instead."
    const openai = bodyOf(buildRequest(cfg('openai'), 'sys', TEXT))
    expect(openai).toMatchObject({
      model: 'the-model',
      max_completion_tokens: 8192,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'the paper' },
      ],
    })
    expect(openai.max_tokens).toBeUndefined()
    // The system prompt is a message, not a top-level field, on this family.
    expect(openai.system).toBeUndefined()

    const google = bodyOf(buildRequest(cfg('google'), 'sys', TEXT))
    expect(google).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'the paper' }] }],
      systemInstruction: { parts: [{ text: 'sys' }] },
      generationConfig: { maxOutputTokens: 8192 },
    })
  })

  it('sends the output-length parameter each provider currently accepts', () => {
    // openai, xai, groq: the newer name; everyone else: the older one. Mixing
    // these up is exactly the class of bug this whole file exists to catch.
    expect(bodyOf(buildRequest(cfg('openai'), 's', TEXT)).max_completion_tokens).toBe(8192)
    expect(bodyOf(buildRequest(cfg('xai'), 's', TEXT)).max_completion_tokens).toBe(8192)
    expect(bodyOf(buildRequest(cfg('groq'), 's', TEXT)).max_completion_tokens).toBe(8192)
    for (const p of ['openrouter', 'mistral', 'deepseek', 'openai-compatible'] as const) {
      const body = bodyOf(buildRequest(cfg(p, { baseUrl: 'http://x' }), 's', TEXT))
      expect(body.max_tokens).toBe(8192)
      expect(body.max_completion_tokens).toBeUndefined()
    }
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

    const google = bodyOf(buildRequest(cfg('google'), 'sys', PDF))
    const gparts = google.contents[0].parts
    expect(gparts[0]).toEqual({
      inline_data: { mime_type: 'application/pdf', data: 'QkFTRTY0' },
    })
    expect(gparts[1].text).toBeTruthy()
  })

  it('honours a maxTokens override', () => {
    expect(bodyOf(buildRequest(cfg('anthropic'), 's', TEXT, { maxTokens: 100 })).max_tokens).toBe(100)
    expect(bodyOf(buildRequest(cfg('openrouter'), 's', TEXT, { maxTokens: 100 })).max_tokens).toBe(100)
    expect(bodyOf(buildRequest(cfg('openai'), 's', TEXT, { maxTokens: 100 })).max_completion_tokens).toBe(
      100,
    )
    expect(
      bodyOf(buildRequest(cfg('google'), 's', TEXT, { maxTokens: 100 })).generationConfig.maxOutputTokens,
    ).toBe(100)
  })

  it('defaults to a budget with real headroom for a reasoning model, not a bare-minimum one', () => {
    // Regression guard for the bug this budget exists to prevent: a reasoning
    // model can spend the entire cap on hidden reasoning tokens before writing
    // any visible answer, so a too-tight default silently starves every call
    // made against one. This does not pin an exact number — only that nobody
    // "optimizes" it back down near the range that is known to fail in practice
    // (single/low-hundreds of tokens; see aiStore's VERIFY_MAX_TOKENS comment).
    const defaultBudget = bodyOf(buildRequest(cfg('openai'), 's', TEXT)).max_completion_tokens
    expect(defaultBudget).toBeGreaterThanOrEqual(4096)
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
    expect(extractText('groq', { choices: [{ message: { content: 'hi' } }] })).toBe('hi')
    expect(extractText('mistral', { choices: [{ message: { content: 'hi' } }] })).toBe('hi')
    expect(extractText('deepseek', { choices: [{ message: { content: 'hi' } }] })).toBe('hi')
    expect(extractText('xai', { choices: [{ message: { content: 'hi' } }] })).toBe('hi')
  })

  it('reads a Gemini response and skips parts with no text (thinking models)', () => {
    const json = {
      candidates: [
        {
          content: {
            parts: [
              { thoughtSignature: 'abc' },
              { text: '{"fields":' },
              { text: '[]}' },
            ],
          },
        },
      ],
    }
    expect(extractText('google', json)).toBe('{"fields":[]}')
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

describe('wasTruncated', () => {
  // This is the regression test for the reported bug: a reasoning model (e.g.
  // OpenAI's gpt-5.5) can spend its whole token budget on hidden reasoning and
  // come back with a 2xx response, an empty visible answer, and one of these
  // flags — not an HTTP error. Each shape here is the provider's own documented
  // field for "cut off by the token limit", not a guess.
  it('reads each provider\'s own "cut off by the token budget" flag', () => {
    expect(wasTruncated('anthropic', { stop_reason: 'max_tokens' })).toBe(true)
    expect(wasTruncated('anthropic', { stop_reason: 'end_turn' })).toBe(false)

    expect(wasTruncated('google', { candidates: [{ finishReason: 'MAX_TOKENS' }] })).toBe(true)
    expect(wasTruncated('google', { candidates: [{ finishReason: 'STOP' }] })).toBe(false)

    for (const p of ['openai', 'openrouter', 'groq', 'mistral', 'deepseek', 'xai', 'openai-compatible'] as const) {
      expect(wasTruncated(p, { choices: [{ finish_reason: 'length' }] })).toBe(true)
      expect(wasTruncated(p, { choices: [{ finish_reason: 'stop' }] })).toBe(false)
    }
  })

  it('is false, not thrown, for anything unexpected', () => {
    for (const p of PROVIDER_LIST.map((i) => i.id)) {
      expect(wasTruncated(p, null)).toBe(false)
      expect(wasTruncated(p, 'not json')).toBe(false)
      expect(wasTruncated(p, {})).toBe(false)
      expect(wasTruncated(p, { choices: [] })).toBe(false)
      expect(wasTruncated(p, { candidates: [] })).toBe(false)
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
    // Google's error envelope: { error: { code, message, status } }.
    expect(
      extractError(
        'google',
        400,
        '{"error":{"code":400,"message":"API key not valid","status":"INVALID_ARGUMENT"}}',
      ),
    ).toContain('API key not valid')
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
