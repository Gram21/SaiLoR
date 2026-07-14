import type { LlmConfig, LlmHttpRequest, Provider } from './types'
import { API_KEY_SENTINEL } from './types'

/**
 * Everything that differs between the LLM vendors, in one place: where to POST,
 * how to authenticate, how to shape the body, how to read the answer back out.
 *
 * Two rules hold for every provider here:
 *  - **No API key.** Requests are built in the renderer, so the key cannot pass
 *    through this module; headers carry `API_KEY_SENTINEL` and the main process
 *    substitutes the real key just before sending (see `types.ts`).
 *  - **No throwing on a bad response.** Providers fail in creative ways and the
 *    body is whatever the server felt like sending, so `extractText` degrades to
 *    `''` and `extractError` always yields something a reviewer can read.
 */

export interface ProviderInfo {
  id: Provider
  label: string
  defaultBaseUrl: string
  /** Whether the user may edit baseUrl (true only for 'openai-compatible'). */
  editableBaseUrl: boolean
  /** Whether this provider can accept a PDF natively (the fallback path). */
  supportsPdf: boolean
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    editableBaseUrl: false,
    supportsPdf: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com',
    editableBaseUrl: false,
    supportsPdf: true,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api',
    editableBaseUrl: false,
    supportsPdf: true,
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    defaultBaseUrl: '',
    editableBaseUrl: true,
    // A self-hosted server (llama.cpp, LM Studio, vLLM…) almost never takes a PDF,
    // so the UI must keep such a target on the extracted-text path.
    supportsPdf: false,
  },
}

export const PROVIDER_LIST: ProviderInfo[] = [
  PROVIDERS.anthropic,
  PROVIDERS.openai,
  PROVIDERS.openrouter,
  PROVIDERS['openai-compatible'],
]

/** The paper, as handed to the model. */
export type PaperPart =
  | { kind: 'text'; text: string }
  | { kind: 'pdf'; base64: string; filename: string }

const DEFAULT_MAX_TOKENS = 4096

/**
 * The user turn that accompanies an attached PDF. The instructions live in the
 * system prompt, but both APIs want the attachment to sit next to *some* text —
 * an attachment-only turn is at best undefined behaviour on OpenAI-compatible
 * servers.
 */
const PDF_USER_TEXT = 'The paper is attached as a PDF. Annotate it as instructed.'

const CHAT_PATH = '/v1/chat/completions'

/**
 * Append `path` to `base` without duplicating what the user already typed.
 *
 * Only `openai-compatible` has a user-supplied base, and people reasonably enter
 * any of `http://host:1234`, `…/v1` or the full `…/v1/chat/completions` — all
 * three are "the endpoint" as far as they are concerned. So we look for the
 * longest prefix of `path` that `base` already ends with and add only the rest.
 */
export function join(base: string, path: string): string {
  const b = base.trim().replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  const segs = p.split('/').filter(Boolean)

  for (let i = segs.length; i > 0; i--) {
    const overlap = `/${segs.slice(0, i).join('/')}`
    if (b.toLowerCase().endsWith(overlap.toLowerCase())) {
      const rest = segs.slice(i)
      return rest.length === 0 ? b : `${b}/${rest.join('/')}`
    }
  }
  return b + p
}

/** The endpoint root actually in use: the configured one, or the provider's fixed default. */
function baseOf(cfg: LlmConfig): string {
  const configured = cfg.baseUrl?.trim() ?? ''
  return configured || PROVIDERS[cfg.provider].defaultBaseUrl
}

function anthropicContent(user: PaperPart): unknown[] {
  if (user.kind === 'text') return [{ type: 'text', text: user.text }]
  return [
    {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: user.base64 },
    },
    { type: 'text', text: PDF_USER_TEXT },
  ]
}

function openaiContent(user: PaperPart): unknown {
  // A plain string keeps the common (text) path portable: every OpenAI-compatible
  // server accepts it, while the parts array is a newer addition some do not know.
  if (user.kind === 'text') return user.text
  return [
    {
      type: 'file',
      file: {
        filename: user.filename,
        file_data: `data:application/pdf;base64,${user.base64}`,
      },
    },
    { type: 'text', text: PDF_USER_TEXT },
  ]
}

export function buildRequest(
  cfg: LlmConfig,
  system: string,
  user: PaperPart,
  opts?: { maxTokens?: number },
): LlmHttpRequest {
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS
  const base = baseOf(cfg)

  if (cfg.provider === 'anthropic') {
    return {
      configId: cfg.id,
      url: join(base, '/v1/messages'),
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY_SENTINEL,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: anthropicContent(user) }],
      }),
    }
  }

  return {
    configId: cfg.id,
    url: join(base, CHAT_PATH),
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${API_KEY_SENTINEL}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: openaiContent(user) },
      ],
    }),
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Join the `.text` of every part in an OpenAI-style content array. */
function textOfParts(parts: unknown[]): string {
  return parts
    .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
    .join('')
}

/** Pull the assistant's text out of a provider's JSON response. Returns '' if absent. */
export function extractText(provider: Provider, json: unknown): string {
  if (!isRecord(json)) return ''

  if (provider === 'anthropic') {
    const content = json.content
    if (!Array.isArray(content)) return ''
    // Anthropic returns a list of blocks; only the text ones carry the answer,
    // anything else (thinking, tool_use…) is not ours to read.
    return content
      .map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('')
  }

  const choices = json.choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first = choices[0]
  if (!isRecord(first)) return ''
  const message = first.message
  if (!isRecord(message)) return ''

  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return textOfParts(content)
  return ''
}

/** Keep an error readable in the UI: an HTML error page or a huge body helps nobody. */
function truncate(s: string, max = 200): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** Human-readable error from a failed response body, for the UI. */
export function extractError(provider: Provider, status: number, body: string): string {
  const label = PROVIDERS[provider]?.label ?? provider
  const fallback = body.trim()
    ? `${label}: HTTP ${status} — ${truncate(body)}`
    : `${label}: HTTP ${status}`

  let json: unknown
  try {
    json = JSON.parse(body) as unknown
  } catch {
    return fallback
  }
  if (!isRecord(json)) return fallback

  // The usual shape is { error: { message } }, but plenty of servers flatten it
  // to { error: "…" } or { message: "…" }.
  const error = json.error
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return `${label}: ${error.message.trim()}`
  }
  if (typeof error === 'string' && error.trim()) return `${label}: ${error.trim()}`
  if (typeof json.message === 'string' && json.message.trim()) {
    return `${label}: ${json.message.trim()}`
  }
  return fallback
}
