import type { LlmConfig, LlmHttpRequest, ModelInfo, ModelsPage, Provider, ReasoningProfile } from './types'
import { API_KEY_SENTINEL } from './types'
import { baseOf, join } from './providers'

/**
 * "Ask the API yourself which models are available" — one GET per provider,
 * turned into the flat `{id, label, reasoning}` shape the model picker needs.
 *
 * Every provider's list-models endpoint is public-shaped (no PDF/attachment
 * concerns, no streaming), but the response envelope, pagination scheme, and
 * — critically — whether/how a model exposes reasoning-effort control are all
 * different. That heterogeneity lives entirely in this file, the same way
 * `providers.ts` isolates the differences in the chat-completion call itself.
 *
 * Reasoning-effort detection is a mix of two things:
 *  - **Read from the response**, when the provider says so itself: Anthropic's
 *    `capabilities.effort`, Google's `thinking` flag, OpenRouter's per-model
 *    `reasoning` metadata (`supported_efforts`). These are trustworthy and
 *    need no maintenance as new models ship.
 *  - **A model-ID pattern**, when the provider's list endpoint says nothing
 *    about it (OpenAI, Groq, xAI, Mistral): a best-effort allowlist that will
 *    go stale as new models ship and has to be revisited then. Two providers
 *    are deliberately left with NO reasoning-effort control at all rather than
 *    a guess: DeepSeek, whose new `reasoning_effort` contract could not be
 *    confirmed against primary docs at the time this was written, and
 *    `openai-compatible` self-hosted servers (llama.cpp, vLLM, LM Studio),
 *    across which there is no single agreed-upon request shape for it today —
 *    offering a control that silently does nothing on some servers would be
 *    worse than not offering one.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** "medium" when the model offers it, else the level in the middle of the range. */
function reasoningProfile(levels: string[]): ReasoningProfile {
  const defaultLevel = levels.includes('medium') ? 'medium' : levels[Math.floor(levels.length / 2)]
  return { levels, defaultLevel }
}

// ---- Reasoning-effort detection, per provider ----

// A conservative subset of OpenAI's documented "none, minimal, low, medium,
// high, xhigh, max": the top and bottom tiers are confirmed only for the
// newest model family, and sending a value a model rejects fails the whole
// call, so this sticks to the range confirmed across the o-series and the
// GPT-5.x family. "-chat" variants (e.g. gpt-5-chat-latest) are conversational
// siblings of the reasoning models and reject the field outright.
function openaiReasoning(id: string): ReasoningProfile | null {
  if (id.includes('-chat')) return null
  return /^o[0-9]/.test(id) || /^gpt-5/.test(id) ? reasoningProfile(['minimal', 'low', 'medium', 'high']) : null
}

// Groq documents `reasoning_effort` only for the GPT-OSS family; Qwen models on
// Groq reason by default with an on/off switch (`none`/`default`), not a
// graduated effort scale, so they are left without a reasoning profile here.
function groqReasoning(id: string): ReasoningProfile | null {
  return /^openai\/gpt-oss/.test(id) ? reasoningProfile(['low', 'medium', 'high']) : null
}

// xAI documents `reasoning_effort` only for grok-4.5; earlier Grok models
// either don't reason or reason with no effort control exposed.
function xaiReasoning(id: string): ReasoningProfile | null {
  return /^grok-4\.5/.test(id) ? reasoningProfile(['low', 'medium', 'high']) : null
}

// Mistral documents `reasoning_effort` on its mainline small/medium models
// (the dedicated "Magistral" reasoning models are being folded into this and
// carry no effort control of their own).
function mistralReasoning(id: string): ReasoningProfile | null {
  return /^mistral-(small|medium)/.test(id)
    ? reasoningProfile(['minimal', 'low', 'medium', 'high'])
    : null
}

// Anthropic's own /v1/models response says which models take an effort level,
// and exactly which levels — no guessing needed. Shape (subset used here):
//   capabilities: { effort: { supported: true, low: { supported: true }, ... } }
function anthropicReasoning(capabilities: unknown): ReasoningProfile | null {
  if (!isRecord(capabilities)) return null
  const effort = capabilities.effort
  if (!isRecord(effort) || effort.supported !== true) return null
  const order = ['low', 'medium', 'high', 'xhigh', 'max']
  const levels = order.filter((lvl) => {
    const entry = effort[lvl]
    return isRecord(entry) && entry.supported === true
  })
  return levels.length > 0 ? reasoningProfile(levels) : null
}

// ---- List-models requests ----

const V1_MODELS = '/v1/models'

/**
 * Resolve a pagination cursor against the target's base URL and confirm it did
 * not leave the origin. Returns null when it did — the caller must then stop
 * paginating rather than send the API key somewhere new.
 */
function resolveSameOrigin(base: string, cursor: string): string | null {
  try {
    const baseUrl = new URL(base)
    const next = new URL(cursor, baseUrl)
    return next.origin === baseUrl.origin ? next.toString() : null
  } catch {
    return null
  }
}

/** Null when a provider's own pagination cursor cannot be trusted — see
 *  `resolveSameOrigin`. The caller stops paginating and keeps what it has. */
export function buildModelsRequest(cfg: LlmConfig, cursor?: string): LlmHttpRequest | null {
  const base = baseOf(cfg)

  if (cfg.provider === 'anthropic') {
    const params = new URLSearchParams({ limit: '100' })
    if (cursor) params.set('after_id', cursor)
    return {
      configId: cfg.id,
      url: `${join(base, V1_MODELS)}?${params}`,
      method: 'GET',
      headers: { 'x-api-key': API_KEY_SENTINEL, 'anthropic-version': '2023-06-01' },
    }
  }

  if (cfg.provider === 'google') {
    const params = new URLSearchParams({ pageSize: '200' })
    if (cursor) params.set('pageToken', cursor)
    return {
      configId: cfg.id,
      url: `${join(base, '/v1beta/models')}?${params}`,
      method: 'GET',
      headers: { 'x-goog-api-key': API_KEY_SENTINEL },
    }
  }

  if (cfg.provider === 'openrouter') {
    // OpenRouter hands back its own "next" URL (see parseOpenRouterModels), so
    // a follow-up page is just that URL against this target's origin — no
    // offset bookkeeping on this side.
    if (cursor) {
      // Resolved against the base as a URL, then checked — never concatenated.
      // `cursor` is whatever `links.next` said, and this request carries the
      // user's API key: `${origin}${cursor}` let a cursor of "@evil.com/v1/models"
      // read as userinfo, producing https://openrouter.ai@evil.com/... and
      // handing the key to evil.com. Resolution keeps a relative cursor working
      // while the origin check makes an absolute one unable to redirect it.
      const next = resolveSameOrigin(base, cursor)
      if (!next) return null
      return {
        configId: cfg.id,
        url: next,
        method: 'GET',
        headers: { Authorization: `Bearer ${API_KEY_SENTINEL}` },
      }
    }
    return {
      configId: cfg.id,
      url: `${join(base, V1_MODELS)}?limit=200`,
      method: 'GET',
      headers: { Authorization: `Bearer ${API_KEY_SENTINEL}` },
    }
  }

  // OpenAI, Groq, Mistral, DeepSeek, xAI, openai-compatible: a flat,
  // unpaginated GET /v1/models with a bearer key.
  return {
    configId: cfg.id,
    url: join(base, V1_MODELS),
    method: 'GET',
    headers: { Authorization: `Bearer ${API_KEY_SENTINEL}` },
  }
}

// ---- List-models responses ----

function parseFlatList(
  json: unknown,
  reasoning: (id: string) => ReasoningProfile | null,
): ModelsPage {
  if (!isRecord(json) || !Array.isArray(json.data)) return { models: [] }
  const models = json.data.flatMap((m): ModelInfo[] => {
    if (!isRecord(m) || typeof m.id !== 'string') return []
    return [{ id: m.id, label: m.id, reasoning: reasoning(m.id) }]
  })
  return { models }
}

function parseMistralModels(json: unknown): ModelsPage {
  // Mistral's /v1/models returns a bare array, not an OpenAI-style envelope.
  const arr = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json.data) ? json.data : null
  if (!arr) return { models: [] }
  const models = arr.flatMap((m): ModelInfo[] => {
    if (!isRecord(m) || typeof m.id !== 'string') return []
    return [{ id: m.id, label: m.id, reasoning: mistralReasoning(m.id) }]
  })
  return { models }
}

function parseAnthropicModels(json: unknown): ModelsPage {
  if (!isRecord(json) || !Array.isArray(json.data)) return { models: [] }
  const models = json.data.flatMap((m): ModelInfo[] => {
    if (!isRecord(m) || typeof m.id !== 'string') return []
    const label = typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id
    return [{ id: m.id, label, reasoning: anthropicReasoning(m.capabilities) }]
  })
  const nextCursor = json.has_more === true && typeof json.last_id === 'string' ? json.last_id : undefined
  return { models, nextCursor }
}

function parseGoogleModels(json: unknown): ModelsPage {
  if (!isRecord(json) || !Array.isArray(json.models)) return { models: [] }
  const models = json.models.flatMap((m): ModelInfo[] => {
    if (!isRecord(m) || typeof m.name !== 'string') return []
    // Embedding/TTS/image/live variants share the models list but take no
    // chat turn at all, so they cannot answer the annotation prompt.
    const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : []
    if (!methods.includes('generateContent')) return []
    const id = m.name.replace(/^models\//, '')
    const label = typeof m.displayName === 'string' && m.displayName ? m.displayName : id
    return [{ id, label, reasoning: m.thinking === true ? reasoningProfile(['low', 'medium', 'high']) : null }]
  })
  const nextCursor = typeof json.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : undefined
  return { models, nextCursor }
}

function parseOpenRouterModels(json: unknown): ModelsPage {
  if (!isRecord(json) || !Array.isArray(json.data)) return { models: [] }
  const models = json.data.flatMap((m): ModelInfo[] => {
    if (!isRecord(m) || typeof m.id !== 'string') return []
    const label = typeof m.name === 'string' && m.name ? m.name : m.id
    return [{ id: m.id, label, reasoning: openrouterReasoning(m.reasoning) }]
  })
  const nextCursor = isRecord(json.links) && typeof json.links.next === 'string' ? json.links.next : undefined
  return { models, nextCursor }
}

// OpenRouter's own per-model metadata: { supported_efforts: string[], ... }.
function openrouterReasoning(raw: unknown): ReasoningProfile | null {
  if (!isRecord(raw) || !Array.isArray(raw.supported_efforts)) return null
  const levels = raw.supported_efforts.filter((l): l is string => typeof l === 'string')
  return levels.length > 0 ? reasoningProfile(levels) : null
}

export function parseModelsResponse(provider: Provider, json: unknown): ModelsPage {
  if (provider === 'anthropic') return parseAnthropicModels(json)
  if (provider === 'google') return parseGoogleModels(json)
  if (provider === 'openrouter') return parseOpenRouterModels(json)
  if (provider === 'mistral') return parseMistralModels(json)
  if (provider === 'groq') return parseFlatList(json, groqReasoning)
  if (provider === 'xai') return parseFlatList(json, xaiReasoning)
  if (provider === 'openai') return parseFlatList(json, openaiReasoning)
  // DeepSeek and openai-compatible servers: same OpenAI-shaped envelope, but
  // no reasoning-effort control offered — see the file comment above.
  return parseFlatList(json, () => null)
}
