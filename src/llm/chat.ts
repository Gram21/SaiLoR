import type { LlmConfig, LlmHttpRequest, Provider } from './types'
import { API_KEY_SENTINEL } from './types'
import {
  PROVIDERS,
  baseOf,
  join,
  anthropicContent,
  openaiContent,
  googleParts,
  anthropicThinkingFields,
  googleThinkingConfig,
  openaiReasoningFields,
  type PaperPart,
} from './providers'

/**
 * Provider-neutral tool-calling on top of `providers.ts`'s single-shot request
 * building. Agent mode needs a multi-turn conversation with tool calls, which
 * the three wire formats disagree about in every particular (where the paper
 * goes, how a tool call/result is shaped, what a "system" message even is) —
 * this module is the one place that difference is translated, reusing the
 * paper-attachment and reasoning-effort helpers `providers.ts` already has.
 */

/** A JSON Schema object, loosely typed — this app only ever builds these itself. */
export type JsonSchema = Record<string, unknown>

export interface ToolDef {
  name: string
  description: string
  parameters: JsonSchema
}

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export type ChatRole = 'user' | 'assistant' | 'tool'

/** One turn of the conversation, in the app's own neutral shape. */
export interface ChatMessage {
  role: ChatRole
  /** Assistant's visible text, or the user's message text. Absent on a
   *  tool-only assistant turn. */
  content?: string
  /** Assistant only: the tool calls it made this turn. */
  toolCalls?: ToolCall[]
  /** Tool only: which call this is the result of, and the tool's name. */
  toolCallId?: string
  name?: string
  /**
   * Assistant only: the provider's own content blocks/parts for this turn,
   * captured from the response that produced it. Anthropic's extended
   * thinking and Gemini's `thoughtSignature` must be echoed back verbatim on
   * a later turn that continues the same tool-use sequence — reconstructing
   * an equivalent turn from `content`/`toolCalls` alone would drop them, so
   * when `raw` is present it is replayed instead of being rebuilt.
   */
  raw?: unknown
}

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
}

export interface ChatResponse {
  text: string
  toolCalls: ToolCall[]
  truncated: boolean
  usage: ChatUsage
  /** The raw assistant turn, for `ChatMessage.raw` on the next request. */
  raw: unknown
  /** Provider-side web searches run for this response (0 without web search). */
  webSearches: number
  /** Every result/citation URL the provider's web search surfaced, deduped. */
  citations: { url: string; title?: string }[]
  /** Anthropic `pause_turn`: the server-tool loop paused; send `raw` back to continue. */
  paused: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

const CHAT_PATH = '/v1/chat/completions'

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/** Group consecutive `tool` messages: Anthropic and Gemini expect all of one
 *  round's tool results in a single turn, not one turn per result. */
function groupToolRuns(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = []
  for (const m of messages) {
    const last = groups[groups.length - 1]
    if (m.role === 'tool' && last && last[0].role === 'tool') last.push(m)
    else groups.push([m])
  }
  return groups
}

function anthropicMessages(messages: ChatMessage[], paper?: PaperPart): unknown[] {
  const groups = groupToolRuns(messages)
  let firstUser = true
  return groups.map((group) => {
    const m = group[0]

    if (m.role === 'tool') {
      return {
        role: 'user',
        content: group.map((t) => ({
          type: 'tool_result',
          tool_use_id: t.toolCallId,
          content: [{ type: 'text', text: t.content ?? '' }],
        })),
      }
    }

    if (m.role === 'assistant') {
      if (m.raw !== undefined) return { role: 'assistant', content: m.raw }
      const content: unknown[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
      }
      return { role: 'assistant', content }
    }

    // user
    if (firstUser && paper) {
      firstUser = false
      const paperBlocks = anthropicContent(paper)
      // Cache the paper (and whatever precedes it) — it's the stable prefix
      // repeated on every round of the loop.
      const last = paperBlocks[paperBlocks.length - 1]
      if (isRecord(last)) last.cache_control = { type: 'ephemeral' }
      const text = m.content ? [{ type: 'text', text: m.content }] : []
      return { role: 'user', content: [...paperBlocks, ...text] }
    }
    firstUser = false
    return { role: 'user', content: [{ type: 'text', text: m.content ?? '' }] }
  })
}

function googleContents(messages: ChatMessage[], paper?: PaperPart): unknown[] {
  const groups = groupToolRuns(messages)
  let firstUser = true
  return groups.map((group) => {
    const m = group[0]

    if (m.role === 'tool') {
      return {
        role: 'function',
        parts: group.map((t) => ({
          functionResponse: { name: t.name ?? '', response: { content: t.content ?? '' } },
        })),
      }
    }

    if (m.role === 'assistant') {
      if (m.raw !== undefined) return { role: 'model', parts: m.raw }
      const parts: unknown[] = []
      if (m.content) parts.push({ text: m.content })
      for (const tc of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: tc.name, args: tc.args } })
      }
      return { role: 'model', parts }
    }

    // user
    if (firstUser && paper) {
      firstUser = false
      const paperParts = googleParts(paper)
      const text = m.content ? [{ text: m.content }] : []
      return { role: 'user', parts: [...paperParts, ...text] }
    }
    firstUser = false
    return { role: 'user', parts: [{ text: m.content ?? '' }] }
  })
}

function openaiMessages(messages: ChatMessage[], paper?: PaperPart): unknown[] {
  let firstUser = true
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' }
    }

    if (m.role === 'assistant') {
      if (m.raw !== undefined) return m.raw
      return {
        role: 'assistant',
        content: m.content ?? null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
              })),
            }
          : {}),
      }
    }

    // user
    if (firstUser && paper) {
      firstUser = false
      const paperPart = openaiContent(paper)
      const paperParts = Array.isArray(paperPart) ? paperPart : [{ type: 'text', text: paperPart }]
      const text = m.content ? [{ type: 'text', text: m.content }] : []
      return { role: 'user', content: [...paperParts, ...text] }
    }
    firstUser = false
    return { role: 'user', content: m.content ?? '' }
  })
}

const DEFAULT_MAX_TOKENS = 8192

/** Cap on provider-side searches per request (cost + prompt-injection surface). */
const WEB_SEARCH_MAX_USES = 5

// Only these providers can mix built-in web search with our function tools —
// see `supportsWebSearch` in providers.ts for the per-provider decisions.
// Anthropic's basic version needs no code-execution sidecar (unlike 20260209+).
const ANTHROPIC_WEB_SEARCH = { type: 'web_search_20250305', name: 'web_search', max_uses: WEB_SEARCH_MAX_USES }

export function buildChatRequest(
  cfg: LlmConfig,
  system: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  opts?: { maxTokens?: number; paper?: PaperPart; webSearch?: boolean },
): LlmHttpRequest & { body: string } {
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS
  const base = baseOf(cfg)
  const effort = cfg.reasoningEffort
  const webSearch = Boolean(opts?.webSearch) && PROVIDERS[cfg.provider].supportsWebSearch

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
        // Caching the (typically long, static) system prompt too — it repeats
        // unchanged on every round of the loop, same as the paper.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: anthropicMessages(messages, opts?.paper),
        ...(tools.length || webSearch
          ? {
              tools: [
                ...tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters,
                })),
                ...(webSearch ? [ANTHROPIC_WEB_SEARCH] : []),
              ],
            }
          : {}),
        ...anthropicThinkingFields(effort),
      }),
    }
  }

  if (cfg.provider === 'google') {
    const thinkingConfig = googleThinkingConfig(cfg.model, effort)
    return {
      configId: cfg.id,
      url: join(base, `/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`),
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': API_KEY_SENTINEL,
      },
      body: JSON.stringify({
        contents: googleContents(messages, opts?.paper),
        systemInstruction: { parts: [{ text: system }] },
        ...(tools.length
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  })),
                },
              ],
            }
          : {}),
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
      messages: [{ role: 'system', content: system }, ...openaiMessages(messages, opts?.paper)],
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(webSearch ? { plugins: [{ id: 'web', max_results: WEB_SEARCH_MAX_USES }] } : {}),
      ...openaiReasoningFields(cfg.provider, effort),
    }),
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function safeParseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    // A model can send malformed JSON arguments; the tool executor validates
    // args defensively, so handing it the raw (unparsed) string is enough to
    // let it report a clean error rather than this module throwing.
    return raw
  }
}

export function parseChatResponse(provider: Provider, json: unknown): ChatResponse {
  const empty: ChatResponse = {
    text: '',
    toolCalls: [],
    truncated: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    raw: undefined,
    webSearches: 0,
    citations: [],
    paused: false,
  }
  if (!isRecord(json)) return empty

  if (provider === 'anthropic') {
    const content = Array.isArray(json.content) ? json.content : []
    const text = content
      .map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('')
    const toolCalls: ToolCall[] = content
      .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'tool_use')
      .map((b) => ({
        id: String(b.id ?? ''),
        name: String(b.name ?? ''),
        args: b.input,
      }))
    const usage = isRecord(json.usage) ? json.usage : {}
    // Server-tool blocks are not ours to execute; we only read result/citation URLs.
    const citations = uniqueCitations(
      content.flatMap((b) => {
        if (!isRecord(b)) return []
        if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) return b.content
        if (b.type === 'text' && Array.isArray(b.citations)) return b.citations
        return []
      }),
    )
    const stu = isRecord(usage.server_tool_use) ? usage.server_tool_use : {}
    const searchBlocks = content.filter(
      (b) => isRecord(b) && b.type === 'server_tool_use' && b.name === 'web_search',
    ).length
    return {
      text,
      toolCalls,
      truncated: json.stop_reason === 'max_tokens',
      usage: {
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      },
      raw: content,
      webSearches: typeof stu.web_search_requests === 'number' ? stu.web_search_requests : searchBlocks,
      citations,
      paused: json.stop_reason === 'pause_turn',
    }
  }

  if (provider === 'google') {
    const candidates = Array.isArray(json.candidates) ? json.candidates : []
    const first = candidates[0]
    const parts =
      isRecord(first) && isRecord(first.content) && Array.isArray(first.content.parts)
        ? first.content.parts
        : []
    const text = parts
      .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
      .join('')
    const toolCalls: ToolCall[] = parts
      .filter((p): p is Record<string, unknown> => isRecord(p) && isRecord(p.functionCall))
      .map((p, i) => {
        const fc = p.functionCall as Record<string, unknown>
        return { id: `call_${i}`, name: String(fc.name ?? ''), args: fc.args }
      })
    const usage = isRecord(json.usageMetadata) ? json.usageMetadata : {}
    return {
      text,
      toolCalls,
      truncated: isRecord(first) && first.finishReason === 'MAX_TOKENS',
      usage: {
        inputTokens: typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : 0,
        outputTokens: typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0,
      },
      raw: parts,
      webSearches: 0,
      citations: [],
      paused: false,
    }
  }

  // OpenAI-shaped (openai/openrouter/groq/mistral/deepseek/xai/openai-compatible).
  const choices = Array.isArray(json.choices) ? json.choices : []
  const first = choices[0]
  const message = isRecord(first) && isRecord(first.message) ? first.message : {}
  const content = message.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? textOfParts(content) : ''
  const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .filter(isRecord)
        .map((tc) => {
          const fn = isRecord(tc.function) ? tc.function : {}
          return {
            id: String(tc.id ?? ''),
            name: String(fn.name ?? ''),
            args: safeParseArgs(fn.arguments),
          }
        })
    : []
  const usage = isRecord(json.usage) ? json.usage : {}
  // OpenRouter web plugin: url_citation annotations on the message.
  const citations = uniqueCitations(
    (Array.isArray(message.annotations) ? message.annotations : [])
      .filter((a) => isRecord(a) && a.type === 'url_citation')
      .map((a) => (a as Record<string, unknown>).url_citation),
  )
  return {
    text,
    toolCalls,
    truncated: isRecord(first) && first.finish_reason === 'length',
    usage: {
      inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
    },
    raw: message,
    // OpenRouter's plugin reports no search count; one search per annotated reply.
    webSearches: citations.length > 0 ? 1 : 0,
    citations,
    paused: false,
  }
}

/** `{url,title}` from web_search_result / web_search_result_location entries, deduped by URL. */
function uniqueCitations(items: unknown[]): { url: string; title?: string }[] {
  const seen = new Map<string, { url: string; title?: string }>()
  for (const it of items) {
    if (!isRecord(it) || typeof it.url !== 'string' || !it.url) continue
    if (!seen.has(it.url)) seen.set(it.url, { url: it.url, ...(typeof it.title === 'string' ? { title: it.title } : {}) })
  }
  return [...seen.values()]
}

function textOfParts(parts: unknown[]): string {
  return parts
    .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
    .join('')
}
