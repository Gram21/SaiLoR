import type { FieldValue } from '../model/annotations'

/**
 * Shared types for the AI-assisted annotation feature.
 *
 * The one rule that shapes this whole layer: **an API key never lives in the
 * renderer.** `LlmConfig` therefore has no `apiKey` field. In the desktop app the
 * key is held by the main process (encrypted with `safeStorage`) and spliced into
 * the outgoing request there; the renderer only ever sees `hasKey`.
 */

export type Provider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'openai-compatible'

/** How the paper is handed to the model. Text is the default — see `src/model/pdfText.ts`. */
export type Attach = 'text' | 'pdf'

/** One configured LLM target, as the renderer sees it. Never carries the key. */
export interface LlmConfig {
  id: string
  /** Display name in the picker, e.g. "Claude (work key)". */
  name: string
  provider: Provider
  /** Endpoint root. Fixed per provider, except for `openai-compatible`. */
  baseUrl: string
  model: string
  attach: Attach
  /** True when an API key is stored for this target. The key itself is never sent here. */
  hasKey: boolean
  /** True when this target's server needs no API key (e.g. a local Ollama/LM Studio/vLLM). */
  noKey?: boolean
  /**
   * The reasoning-effort level to send with every call on this target, e.g.
   * "medium". Only meaningful when `model` is one `fetchModels` reported as
   * reasoning-capable — see `ModelInfo.reasoning` in `models.ts`. Absent (not
   * an empty string) when the model has no such control, or the reviewer
   * hasn't picked a model yet.
   */
  reasoningEffort?: string
  /**
   * User-entered price for this target, USD per 1M tokens. No built-in price
   * table: provider prices go stale faster than this codebase gets updated,
   * so the reviewer types what their contract actually charges. Absent means
   * "unknown" — cost estimates degrade to null rather than guessing.
   */
  inputPrice?: number
  outputPrice?: number
}

/** Whether a target has what it needs to be called: a stored key, or none required. */
export function isUsable(config: Pick<LlmConfig, 'hasKey' | 'noKey'>): boolean {
  return config.hasKey || Boolean(config.noKey)
}

/**
 * One model a provider's list-models endpoint reported, resolved to what this
 * app needs: something to show, something to send, and whether it takes a
 * reasoning-effort level.
 */
export interface ModelInfo {
  /** Exactly what the provider expects back in the `model` field of a call. */
  id: string
  /** Shown in the picker; falls back to `id` when the provider names nothing else. */
  label: string
  reasoning: ReasoningProfile | null
  /** USD per 1M tokens, when the provider's list-models reply states its own
   *  price (e.g. OpenRouter). Absent — never guessed — otherwise. */
  pricing?: { input: number; output: number }
}

/**
 * A model's reasoning-effort control, as this app exposes it: one flat set of
 * named levels, low-to-high, whatever the provider's own wire shape turns out
 * to be underneath (see `buildRequest` in providers.ts for the per-provider
 * translation — e.g. Gemini 2.5's numeric token budget is derived from the
 * chosen level, not typed in by the reviewer).
 */
export interface ReasoningProfile {
  levels: string[]
  /** The level to preselect: "medium" when the model offers it, else its middle level. */
  defaultLevel: string
}

/** One page of a provider's model list, as `fetchModels` walks it. */
export interface ModelsPage {
  models: ModelInfo[]
  /** Opaque cursor for the next page; absent when this was the last page. */
  nextCursor?: string
}

/**
 * The placeholder that stands in for the API key in a built request's headers.
 * The renderer builds the whole request but can only ever put *this* in it; the
 * main process substitutes the real key immediately before sending.
 */
export const API_KEY_SENTINEL = '{{apiKey}}'

/** A ready-to-send HTTP request, built in shared code, sent by the platform. */
export interface LlmHttpRequest {
  configId: string
  url: string
  headers: Record<string, string>
  /** Defaults to 'POST'. The list-models requests in models.ts are the only GETs. */
  method?: 'GET' | 'POST'
  /** JSON body, already serialized. Absent for GET requests, which carry none. */
  body?: string
}

export interface LlmHttpResponse {
  ok: boolean
  status: number
  /** Raw response body; the caller parses it with the provider's `extractText`. */
  body: string
  /**
   * Milliseconds to wait before retrying, when the platform's HTTP layer read
   * a `Retry-After` header off a 429/503 (see `retry.ts`'s `parseRetryAfter`,
   * which the Electron main process uses to fill this). Absent when the
   * response carried no such header, or on a platform that doesn't parse it.
   */
  retryAfterMs?: number
}

/** One value the model proposes for one field, after validation against the schema. */
export interface Suggestion {
  /** Path as the model wrote it, e.g. "Findings[1]/Evidence[0]/Metric". */
  path: string
  value: FieldValue
  /** Verbatim quote from the paper supporting the value. May be empty if the model gave none. */
  evidence: string
  /** 0..1, as reported by the model. Null when it gave none or gave nonsense. */
  confidence: number | null
  /** Agent mode only: where the value came from — "paper", or the URL of a web source. */
  source?: string
  /** Agent mode only: the judge's last verdict on this value. */
  judge?: JudgeVerdict
}

/** The judge's assessment of one proposed value (agent mode). */
export interface JudgeVerdict {
  verdict: 'accept' | 'revise' | 'reject'
  feedback: string
}

/** Result of fetching a public web page for the agent's `fetch_url` tool. No API key is ever attached. */
export interface WebFetchResult {
  ok: boolean
  status: number
  /** Final URL after any (re-checked) redirects. */
  url: string
  contentType: string
  /** Response body as text, capped in size by the main process. */
  body: string
  truncated: boolean
  /** Why the fetch was refused or failed (blocked host, timeout, unsupported type…). */
  error?: string
}

/** A field the model deliberately left empty, and why. Shown to the reviewer, never applied. */
export interface SkippedField {
  path: string
  reason: string
}

export interface LlmAnswer {
  fields: Suggestion[]
  skipped: SkippedField[]
  /** Suggestions the model returned that we refused (bad path, wrong type, not in options…). */
  rejected: RejectedSuggestion[]
}

export interface RejectedSuggestion {
  path: string
  raw: unknown
  reason: string
}
