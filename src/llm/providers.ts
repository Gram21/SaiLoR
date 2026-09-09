import type { LlmConfig, LlmHttpRequest, Provider } from './types'
import { API_KEY_SENTINEL } from './types'

/**
 * Everything that differs between the LLM vendors: where to POST, how to
 * authenticate, how to shape the body, how to read the answer back out.
 *
 * Two rules hold for every provider here: no API key (headers carry
 * `API_KEY_SENTINEL`, substituted by the main process, see `types.ts`), and
 * no throwing on a bad response (`extractText` degrades to `''`, `extractError`
 * always yields something readable).
 */

export interface ProviderInfo {
  id: Provider
  label: string
  defaultBaseUrl: string
  /** Whether the user may edit baseUrl (true only for 'openai-compatible'). */
  editableBaseUrl: boolean
  /** Whether this provider can accept a PDF natively (the fallback path). */
  supportsPdf: boolean
  /**
   * False only for `openai-compatible`: an arbitrary self-hosted server has no
   * safe-to-assume list-models endpoint/shape, so this app never queries it —
   * the reviewer types the model name and it's never validated for this provider.
   */
  supportsModelListing: boolean
  /**
   * Output-length param for an OpenAI-shaped body (ignored by `anthropic`/`google`,
   * which have their own fields). Not uniform across "OpenAI-compatible" APIs:
   * OpenAI's newer models and xAI/Groq reject `max_tokens` in favor of
   * `max_completion_tokens`, while OpenRouter/Mistral/DeepSeek/self-hosted
   * servers still expect `max_tokens`. Verified per-provider in providers.test.ts.
   */
  tokenParam: 'max_tokens' | 'max_completion_tokens'
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    editableBaseUrl: false,
    supportsPdf: true,
    supportsModelListing: true,
    tokenParam: 'max_tokens', // unused: Anthropic has its own body shape below
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com',
    editableBaseUrl: false,
    supportsPdf: true,
    supportsModelListing: true,
    // Required by o-series/current GPT models (OpenAI rejects `max_tokens` on
    // them); still accepted on older models, so this name is safe to send always.
    tokenParam: 'max_completion_tokens',
  },
  google: {
    id: 'google',
    label: 'Google (Gemini)',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    editableBaseUrl: false,
    supportsPdf: true,
    supportsModelListing: true,
    tokenParam: 'max_tokens', // unused: Gemini has its own body shape below
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api',
    editableBaseUrl: false,
    supportsPdf: true,
    supportsModelListing: true,
    // OpenRouter fronts many backends behind one contract and documents
    // `max_tokens`; it does the per-backend translation, not the caller.
    tokenParam: 'max_tokens',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai',
    editableBaseUrl: false,
    // No inline document/file input on chat completions — text only.
    supportsPdf: false,
    supportsModelListing: true,
    tokenParam: 'max_completion_tokens',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    defaultBaseUrl: 'https://api.mistral.ai',
    editableBaseUrl: false,
    // Mistral only accepts a PDF via `document_url` (a fetchable URL); no
    // inline-base64 variant, and a local file has no URL to give it.
    supportsPdf: false,
    supportsModelListing: true,
    tokenParam: 'max_tokens',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    editableBaseUrl: false,
    supportsPdf: false, // text-only; no file/vision input on any current model
    supportsModelListing: true,
    tokenParam: 'max_tokens',
  },
  xai: {
    id: 'xai',
    label: 'xAI (Grok)',
    defaultBaseUrl: 'https://api.x.ai',
    editableBaseUrl: false,
    // Grok requires uploading a file first and referencing its id in a second
    // call; this app only sends single-request inline attachments.
    supportsPdf: false,
    supportsModelListing: true,
    tokenParam: 'max_completion_tokens',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    defaultBaseUrl: '',
    editableBaseUrl: true,
    // A self-hosted server (llama.cpp, LM Studio, vLLM…) almost never takes a PDF.
    supportsPdf: false,
    supportsModelListing: false,
    // The de facto standard these servers implement; no confirmed support for
    // the OpenAI-specific `max_completion_tokens` rename.
    tokenParam: 'max_tokens',
  },
}

export const PROVIDER_LIST: ProviderInfo[] = [
  PROVIDERS.anthropic,
  PROVIDERS.openai,
  PROVIDERS.google,
  PROVIDERS.openrouter,
  PROVIDERS.groq,
  PROVIDERS.mistral,
  PROVIDERS.deepseek,
  PROVIDERS.xai,
  PROVIDERS['openai-compatible'],
]

/** The paper, as handed to the model. */
export type PaperPart =
  | { kind: 'text'; text: string }
  | { kind: 'pdf'; base64: string; filename: string }

/**
 * On reasoning-capable models, hidden reasoning tokens share the output budget
 * with the visible answer, so long reasoning can exhaust it before any visible
 * text is written (a silent "cut off with no text", not an error). There's no
 * reliable cross-provider way to disable reasoning, so generous headroom is
 * the mitigation — costs nothing on ordinary models since they stop early anyway.
 */
const DEFAULT_MAX_TOKENS = 8192

/** Accompanies an attached PDF: both APIs want the attachment next to some
 * text, and an attachment-only turn is undefined behaviour on some servers. */
const PDF_USER_TEXT = 'The paper is attached as a PDF. Annotate it as instructed.'

const CHAT_PATH = '/v1/chat/completions'

/**
 * Append `path` to `base` without duplicating what the user already typed —
 * a user-supplied `openai-compatible` base may already include `/v1` or the
 * full `/v1/chat/completions`, so we add only whatever suffix of `path` is missing.
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
export function baseOf(cfg: LlmConfig): string {
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
  // A plain string keeps the text path portable: some OpenAI-compatible servers
  // don't know the newer parts-array form.
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

/** Gemini's `Part[]` shape: a plain string user turn becomes one text part. */
function googleParts(user: PaperPart): unknown[] {
  if (user.kind === 'text') return [{ text: user.text }]
  return [
    { inline_data: { mime_type: 'application/pdf', data: user.base64 } },
    { text: PDF_USER_TEXT },
  ]
}

/**
 * Gemini 3.x takes named `thinkingLevel`, 2.5.x takes numeric `thinkingBudget`
 * — mutually exclusive; sending both is an error.
 */
export function googleThinkingMechanism(id: string): 'level' | 'budget' {
  return /^gemini-3/.test(id) ? 'level' : 'budget'
}

/** Token counts standing in for "low/medium/high" on 2.5-era models; within
 * the documented range for every 2.5-series model (128–32768 on 2.5 Pro). */
export const GOOGLE_BUDGET_BY_LEVEL: Record<string, number> = { low: 2000, medium: 8000, high: 24000 }

export function buildRequest(
  cfg: LlmConfig,
  system: string,
  user: PaperPart,
  opts?: { maxTokens?: number },
): LlmHttpRequest & { body: string } {
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS
  const base = baseOf(cfg)
  const effort = cfg.reasoningEffort

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
        // `output_config.effort` is the current, model-agnostic dial; it needs
        // adaptive thinking turned on to have anything to apply effort to.
        ...(effort
          ? { thinking: { type: 'adaptive' }, output_config: { effort } }
          : {}),
      }),
    }
  }

  if (cfg.provider === 'google') {
    // Model lives in the URL path, not the body — a genuinely different shape
    // than the OpenAI family. Auth uses the `x-goog-api-key` header (Google's
    // documented alternative to `?key=`) so the key never sits in a URL, matching
    // this app's header-only sentinel-substitution.
    const thinkingConfig = effort
      ? googleThinkingMechanism(cfg.model) === 'level'
        ? { thinkingLevel: effort }
        : { thinkingBudget: GOOGLE_BUDGET_BY_LEVEL[effort] ?? GOOGLE_BUDGET_BY_LEVEL.medium }
      : null
    return {
      configId: cfg.id,
      url: join(base, `/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`),
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': API_KEY_SENTINEL,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: googleParts(user) }],
        systemInstruction: { parts: [{ text: system }] },
        generationConfig: {
          maxOutputTokens: maxTokens,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      }),
    }
  }

  const { tokenParam } = PROVIDERS[cfg.provider]
  return {
    configId: cfg.id,
    url: join(base, CHAT_PATH),
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${API_KEY_SENTINEL}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      [tokenParam]: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: openaiContent(user) },
      ],
      // OpenRouter's dial is its own nested object; every other OpenAI-shaped
      // provider here (OpenAI, Groq, Mistral, xAI) takes the same flat field.
      ...(effort
        ? cfg.provider === 'openrouter'
          ? { reasoning: { effort } }
          : { reasoning_effort: effort }
        : {}),
    }),
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

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

  if (provider === 'google') {
    const candidates = json.candidates
    if (!Array.isArray(candidates) || candidates.length === 0) return ''
    const content = candidates[0]
    if (!isRecord(content) || !isRecord(content.content)) return ''
    const parts = content.content.parts
    // A part can carry only a thoughtSignature and no text (thinking models),
    // so filter rather than assume every part has one.
    if (!Array.isArray(parts)) return ''
    return textOfParts(parts)
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

/**
 * True when a (2xx) response was cut off by the token budget rather than the
 * model finishing on its own. Lets a caller distinguish "nothing to say" from
 * "cut off before it could say anything" (which `extractText` alone can't).
 */
export function wasTruncated(provider: Provider, json: unknown): boolean {
  if (!isRecord(json)) return false

  if (provider === 'anthropic') return json.stop_reason === 'max_tokens'

  if (provider === 'google') {
    const candidates = json.candidates
    if (!Array.isArray(candidates) || candidates.length === 0) return false
    const first = candidates[0]
    return isRecord(first) && first.finishReason === 'MAX_TOKENS'
  }

  const choices = json.choices
  if (!Array.isArray(choices) || choices.length === 0) return false
  const first = choices[0]
  return isRecord(first) && first.finish_reason === 'length'
}

/** Keep an error readable in the UI: an HTML error page or a huge body helps nobody. */
function truncate(s: string, max = 200): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

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
