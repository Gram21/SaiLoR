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
  /**
   * Whether `fetchModels` may query this provider's list-models endpoint at
   * all. False only for `openai-compatible`: unlike the named providers,
   * there is no single endpoint/auth/response shape it is safe to assume for
   * an arbitrary self-hosted server (llama.cpp, vLLM, LM Studio, a gateway…)
   * — a request built against one server's dialect can 404, hang, or return
   * something `parseModelsResponse` misreads as a working answer. Rather than
   * guess, this app never tries: the reviewer types the model name their
   * server expects, and the field is never validated or marked invalid for
   * this provider (`ModelPicker` only ever flags a mismatch against a list it
   * actually fetched).
   */
  supportsModelListing: boolean
  /**
   * The output-length parameter an OpenAI-shaped body should carry. Ignored for
   * `anthropic` and `google`, which have their own dedicated request shapes with
   * their own field for this (`max_tokens`, `generationConfig.maxOutputTokens`).
   *
   * This is *not* one-size-fits-all across "OpenAI-compatible" APIs, which is
   * exactly the bug this field exists to prevent: OpenAI itself now rejects
   * `max_tokens` on its newer models ("Unsupported parameter: 'max_tokens' is
   * not supported with this model. Use 'max_completion_tokens' instead."), and
   * xAI/Groq have followed the same rename — but OpenRouter, Mistral, DeepSeek,
   * and self-hosted OpenAI-compatible servers (llama.cpp, LM Studio, vLLM) all
   * document `max_tokens` as current and do not confirm support for the newer
   * name. Verified against each provider's own docs; see providers.test.ts.
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
    // OpenAI's own error, verbatim: "'max_tokens' is not supported with this
    // model. Use 'max_completion_tokens' instead." — required for the o-series
    // and current GPT models; still accepted-but-deprecated on older ones, so
    // the newer name is the only one safe to send unconditionally.
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
    // OpenRouter fronts many backends (including OpenAI's) behind one contract;
    // its own reference documents `max_tokens`, not `max_completion_tokens` — it
    // is the one doing the per-backend translation, not the caller.
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
    // Mistral's chat completions take a PDF only via `document_url` (a fetchable
    // URL); there is no inline-base64 variant, and a paper on the reviewer's
    // disk has no URL to give it.
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
    // Grok takes files only by uploading first and referencing the resulting id
    // (or a URL) in a second call — a different flow than the single-request
    // inline attachment this app sends, so it stays on the text path.
    supportsPdf: false,
    supportsModelListing: true,
    tokenParam: 'max_completion_tokens',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    defaultBaseUrl: '',
    editableBaseUrl: true,
    // A self-hosted server (llama.cpp, LM Studio, vLLM…) almost never takes a PDF,
    // so the UI must keep such a target on the extracted-text path.
    supportsPdf: false,
    // See the field comment on `supportsModelListing` above: no endpoint/shape
    // is safe to assume for an arbitrary server, so this app never tries.
    supportsModelListing: false,
    // The de facto standard these servers implement; `max_completion_tokens` is
    // an OpenAI-specific rename with no confirmed support here.
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
 * On a reasoning-capable model (OpenAI's o-series and GPT-5.x, Grok, some Groq
 * and DeepSeek models…), the output-length budget is shared between hidden
 * reasoning tokens and the visible answer — reasoning that runs long can
 * exhaust the whole budget before a single visible token is written, which
 * surfaces as a "finish_reason: length" / "stop_reason: max_tokens" response
 * with **no** usable text, not as an error the caller can react to in advance.
 * There is no reliable, cross-provider way to switch reasoning off (OpenAI's
 * own `reasoning_effort` has been unreliable together with a token cap on
 * Chat Completions), so the only robust mitigation is headroom: the model
 * still stops as soon as it is done, so a generous ceiling costs nothing extra
 * on ordinary models and only matters for the ones that actually need it.
 */
const DEFAULT_MAX_TOKENS = 8192

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

/** Gemini's `Part[]` shape: a plain string user turn becomes one text part. */
function googleParts(user: PaperPart): unknown[] {
  if (user.kind === 'text') return [{ text: user.text }]
  return [
    { inline_data: { mime_type: 'application/pdf', data: user.base64 } },
    { text: PDF_USER_TEXT },
  ]
}

/**
 * Whether a Gemini model takes `thinkingLevel` (named, Gemini 3.x) or
 * `thinkingBudget` (a token count, Gemini 2.5.x) — the two are mutually
 * exclusive on a single request, and sending both is an error.
 */
export function googleThinkingMechanism(id: string): 'level' | 'budget' {
  return /^gemini-3/.test(id) ? 'level' : 'budget'
}

/**
 * Token budgets standing in for "low/medium/high" on the Gemini 2.5-era
 * models, which take a number rather than a named level. Comfortably inside
 * the documented range for every 2.5-series model (128–32768 on 2.5 Pro).
 */
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
    // The model lives in the URL path, not the body — a genuinely different
    // shape from the OpenAI family, not a variant of it. Auth is a header
    // (`x-goog-api-key`), which Google documents as the alternative to a `?key=`
    // query param specifically so the key never has to sit in a URL (matches
    // this app's header-only sentinel-substitution; a query-param key would
    // also need the main-process origin check to parse query strings).
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
 * model finishing on its own — the shape a reasoning model produces when
 * `DEFAULT_MAX_TOKENS`'s headroom still was not enough. `extractText` alone
 * cannot tell "the model had nothing to say" apart from "the model was cut off
 * before it could say anything"; this is what lets a caller tell them apart
 * and say something more useful than "the provider answered, but the reply
 * was empty."
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
