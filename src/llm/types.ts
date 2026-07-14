import type { FieldValue } from '../model/annotations'

/**
 * Shared types for the AI-assisted annotation feature.
 *
 * The one rule that shapes this whole layer: **an API key never lives in the
 * renderer.** `LlmConfig` therefore has no `apiKey` field. In the desktop app the
 * key is held by the main process (encrypted with `safeStorage`) and spliced into
 * the outgoing request there; the renderer only ever sees `hasKey`.
 */

export type Provider = 'anthropic' | 'openai' | 'openrouter' | 'openai-compatible'

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
  /** JSON body, already serialized. */
  body: string
}

export interface LlmHttpResponse {
  ok: boolean
  status: number
  /** Raw response body; the caller parses it with the provider's `extractText`. */
  body: string
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
