import type { LlmConfig } from './types'

/**
 * Pure helpers for a local Ollama server (native API) and the other local
 * servers (LM Studio, llama.cpp, vLLM) the app can discover. No I/O here: the
 * main process (electron/ollama.ts) fetches, this file parses and decides.
 *
 * Why the native `/api/chat` and not Ollama's `/v1/chat/completions`: the
 * OpenAI-compatible route cannot set the context window, and Ollama then
 * silently drops the FRONT of an over-long prompt (the instructions) while
 * answering 200. So every Ollama request sets `options.num_ctx` explicitly and
 * the answer is checked for truncation afterwards.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

// ---- Context window ----

/** Rough token count: ~3 chars per token errs high for English and code. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3)
}

const NUM_CTX_STEP = 1024
const DEFAULT_NUM_CTX = 8192
/** Ollama's reported prompt tokens within this many of num_ctx means the prompt filled the window. */
const TRUNCATION_MARGIN = 64

/**
 * The `num_ctx` to send: prompt + reply (+ hidden reasoning) rounded up to a
 * multiple of 1024, never above the model's own limit when known.
 */
export function computeNumCtx(p: {
  promptTokens: number
  outputReserve: number
  thinkReserve?: number
  modelMax?: number
}): number {
  const need = Math.max(0, p.promptTokens) + Math.max(0, p.outputReserve) + Math.max(0, p.thinkReserve ?? 0)
  const rounded = Math.max(NUM_CTX_STEP, Math.ceil(need / NUM_CTX_STEP) * NUM_CTX_STEP)
  return p.modelMax && p.modelMax > 0 ? Math.min(rounded, p.modelMax) : rounded
}

/**
 * The window for a request: the target's configured one, else sized from the
 * request (never below 8192 — cheap, and small prompts grow across agent rounds).
 */
export function ollamaNumCtx(cfg: Pick<LlmConfig, 'contextTokens'>, promptChars: number, outputReserve: number): number {
  if (cfg.contextTokens && cfg.contextTokens > 0) return cfg.contextTokens
  const computed = computeNumCtx({ promptTokens: estimateTokens(promptChars), outputReserve })
  return Math.max(computed, DEFAULT_NUM_CTX)
}

/**
 * True when Ollama had to cut the prompt. ponytail: prompt-cache reuse can make
 * `prompt_eval_count` smaller than the real prompt, so a truncation after a
 * cache hit can go unseen; real fix is to compare against a client-side count.
 */
export function inputWasTruncated(json: unknown, numCtx: number | undefined): boolean {
  if (!isRecord(json) || numCtx === undefined) return false
  const used = num(json.prompt_eval_count)
  return used !== undefined && used >= numCtx - TRUNCATION_MARGIN
}

const KEEP_ALIVE = '10m'

/** `think` field: off unless an effort is configured; "on" means plain true, a level goes through (gpt-oss). */
function thinkOf(effort: string | undefined): boolean | string {
  if (!effort) return false
  return effort === 'on' || effort === 'true' ? true : effort
}

/**
 * Body for the native `POST /api/chat`. `num_ctx` is always set (see file
 * comment); `num_predict` bounds reasoning + answer together.
 */
export function ollamaChatBody(
  cfg: Pick<LlmConfig, 'model' | 'contextTokens' | 'reasoningEffort'>,
  messages: unknown[],
  tools: unknown[] | undefined,
  maxTokens: number,
): string {
  const promptChars = JSON.stringify(messages).length + (tools ? JSON.stringify(tools).length : 0)
  return JSON.stringify({
    model: cfg.model,
    messages,
    stream: false,
    keep_alive: KEEP_ALIVE,
    think: thinkOf(cfg.reasoningEffort),
    options: { num_ctx: ollamaNumCtx(cfg, promptChars, maxTokens), temperature: 0, num_predict: maxTokens },
    ...(tools?.length ? { tools } : {}),
  })
}

export const INPUT_TRUNCATED_MESSAGE =
  'The local model cut off the start of the prompt (context window too small). Raise the target\'s context size or use a shorter paper.'

/** The `num_ctx` a built `/api/chat` request body carried. */
export function numCtxOfBody(body: string | undefined): number | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    return isRecord(parsed) && isRecord(parsed.options) ? num(parsed.options.num_ctx) : undefined
  } catch {
    return undefined
  }
}

// ---- Model tags ----

const TAG_RE = /^[a-z0-9._/-]+(:[a-z0-9._-]+)?$/

/** A model tag safe to put in a request body and a registry URL (never take one from model output). */
export function isValidModelTag(tag: unknown): tag is string {
  return (
    typeof tag === 'string' &&
    tag.length <= 200 &&
    TAG_RE.test(tag) &&
    !tag.includes('..') &&
    !tag.includes('//') &&
    !tag.startsWith('/')
  )
}

// ---- Response parsers ----

export interface OllamaModel {
  name: string
  sizeBytes: number
  digest?: string
  parameterSize?: string
  quantization?: string
  family?: string
}

/** `GET /api/tags`. */
export function parseTags(json: unknown): OllamaModel[] {
  if (!isRecord(json) || !Array.isArray(json.models)) return []
  return json.models.flatMap((m): OllamaModel[] => {
    if (!isRecord(m)) return []
    const name = str(m.name) ?? str(m.model)
    if (!name) return []
    const d = isRecord(m.details) ? m.details : {}
    return [
      {
        name,
        sizeBytes: num(m.size) ?? 0,
        digest: str(m.digest),
        parameterSize: str(d.parameter_size),
        quantization: str(d.quantization_level),
        family: str(d.family),
      },
    ]
  })
}

/** `POST /api/show`: the `capabilities` list (e.g. "completion", "tools", "thinking", "vision"). */
export function capabilitiesOf(show: unknown): string[] {
  if (!isRecord(show) || !Array.isArray(show.capabilities)) return []
  return show.capabilities.filter((c): c is string => typeof c === 'string')
}

/** The model's own (training) context length from `model_info["<arch>.context_length"]`. */
export function contextOf(show: unknown): number | null {
  if (!isRecord(show) || !isRecord(show.model_info)) return null
  const arch = str(show.model_info['general.architecture'])
  if (!arch) return null
  const n = num(show.model_info[`${arch}.context_length`])
  return n && n > 0 ? n : null
}

/** `thinking` from `/api/show`: accepted `think` values, when the model lists them. */
export function thinkingOf(show: unknown): { values: string[]; default?: string } | null {
  if (!isRecord(show) || !isRecord(show.thinking) || !Array.isArray(show.thinking.values)) return null
  const values = show.thinking.values.filter((v): v is string => typeof v === 'string')
  return values.length ? { values, default: str(show.thinking.default) } : null
}

// A per-layer array (some architectures) is read as its maximum: over-estimates.
const numOrMax = (v: unknown): number | undefined => {
  if (!Array.isArray(v)) return num(v)
  const nums = v.filter((x): x is number => typeof x === 'number')
  return nums.length ? Math.max(...nums) : undefined
}

/**
 * KV-cache size at `numCtx` (f16 K and V): 2 * layers * kv heads * head dim * 2 bytes * ctx.
 * Over-estimates for sliding-window/hybrid models, which keep less. Null when
 * the model_info lacks the fields.
 */
export function estimateKvBytes(modelInfo: unknown, numCtx: number): number | null {
  if (!isRecord(modelInfo)) return null
  const arch = str(modelInfo['general.architecture'])
  if (!arch) return null
  const layers = num(modelInfo[`${arch}.block_count`])
  const heads = numOrMax(modelInfo[`${arch}.attention.head_count`])
  const kvHeads = numOrMax(modelInfo[`${arch}.attention.head_count_kv`]) ?? heads
  const embed = num(modelInfo[`${arch}.embedding_length`])
  const headDim = num(modelInfo[`${arch}.attention.key_length`]) ?? (embed && heads ? embed / heads : undefined)
  if (!layers || !kvHeads || !headDim) return null
  return Math.ceil(2 * layers * kvHeads * headDim * 2 * numCtx)
}

export interface OllamaRunning {
  name: string
  sizeBytes: number
  sizeVram: number
  contextLength?: number
  expiresAt?: string
}

/** `GET /api/ps`: models currently loaded in memory. */
export function parsePs(json: unknown): OllamaRunning[] {
  if (!isRecord(json) || !Array.isArray(json.models)) return []
  return json.models.flatMap((m): OllamaRunning[] => {
    if (!isRecord(m)) return []
    const name = str(m.name) ?? str(m.model)
    if (!name) return []
    return [
      {
        name,
        sizeBytes: num(m.size) ?? 0,
        sizeVram: num(m.size_vram) ?? 0,
        contextLength: num(m.context_length),
        expiresAt: str(m.expires_at),
      },
    ]
  })
}

/** Where a loaded model runs: all on GPU, split (slow), or CPU only. */
export function gpuStatus(e: Pick<OllamaRunning, 'sizeBytes' | 'sizeVram'>): { kind: 'gpu' | 'split' | 'cpu'; pct: number } {
  if (e.sizeVram <= 0) return { kind: 'cpu', pct: 0 }
  if (e.sizeBytes <= 0 || e.sizeVram >= e.sizeBytes) return { kind: 'gpu', pct: 100 }
  return { kind: 'split', pct: Math.round((e.sizeVram / e.sizeBytes) * 100) }
}

export interface PullProgress {
  status: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

/** One NDJSON line of `POST /api/pull`; null when it is not a status/error object. */
export function parsePullLine(line: string): PullProgress | null {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(json)) return null
  const error = str(json.error)
  const status = str(json.status)
  if (!status && !error) return null
  return { status: status ?? 'error', digest: str(json.digest), total: num(json.total), completed: num(json.completed), error }
}

/** Split a streamed NDJSON buffer into complete lines and the unfinished remainder. */
export function drainNdjson(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map((l) => l.trim()).filter(Boolean), rest }
}

// ---- Registry (download size before pulling) ----

/**
 * Manifest URL of the public registry `ollama pull` uses. Not an official API:
 * callers must handle 404/changes and treat the size as an estimate.
 */
export function manifestUrl(tag: string): string | null {
  if (!isValidModelTag(tag)) return null
  const [name, version = 'latest'] = tag.split(':')
  const repo = name.includes('/') ? name : `library/${name}`
  return `https://registry.ollama.ai/v2/${repo}/manifests/${version}`
}

/** Total download size = sum of the manifest's layer sizes; null when unreadable. */
export function sumManifestBytes(json: unknown): number | null {
  if (!isRecord(json) || !Array.isArray(json.layers) || json.layers.length === 0) return null
  let total = 0
  for (const l of json.layers) {
    const size = isRecord(l) ? num(l.size) : undefined
    if (size === undefined || size < 0) return null
    total += size
  }
  return total
}

// ---- Other local servers ----

export type LocalServerKind = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'unknown'

export interface LocalServerModel {
  id: string
  contextTokens?: number
  sizeBytes?: number
  loaded?: boolean
}

export interface LocalServerInfo {
  kind: LocalServerKind
  models: LocalServerModel[]
}

/** LM Studio `GET /api/v1/models`; embedding models are dropped. */
export function parseLmStudioModels(json: unknown): LocalServerModel[] {
  if (!isRecord(json) || !Array.isArray(json.models)) return []
  return json.models.flatMap((m): LocalServerModel[] => {
    if (!isRecord(m) || !str(m.key) || m.type === 'embedding') return []
    const loadedInstances = Array.isArray(m.loaded_instances) ? m.loaded_instances.filter(isRecord) : []
    const cfg = loadedInstances[0] && isRecord(loadedInstances[0].config) ? loadedInstances[0].config : {}
    return [
      {
        id: m.key as string,
        // The loaded window is what will run; max_context_length is only the ceiling.
        contextTokens: num(cfg.context_length) ?? num(m.max_context_length),
        sizeBytes: num(m.size_bytes),
        loaded: loadedInstances.length > 0,
      },
    ]
  })
}

/** llama.cpp `GET /props`: the server's actual window, or null. */
export function parseLlamaCppProps(json: unknown): number | null {
  if (!isRecord(json) || !isRecord(json.default_generation_settings)) return null
  return num(json.default_generation_settings.n_ctx) ?? null
}

/**
 * `GET /v1/models` of llama.cpp (`meta.n_ctx_train`) or vLLM (`max_model_len`).
 * `vllm` is true when any entry states `max_model_len`.
 */
export function parseOpenAiModelsMeta(json: unknown): { models: LocalServerModel[]; vllm: boolean } {
  if (!isRecord(json) || !Array.isArray(json.data)) return { models: [], vllm: false }
  let vllm = false
  const models = json.data.flatMap((m): LocalServerModel[] => {
    if (!isRecord(m) || !str(m.id)) return []
    const maxLen = num(m.max_model_len)
    if (maxLen !== undefined) vllm = true
    const meta = isRecord(m.meta) ? m.meta : {}
    return [{ id: m.id as string, contextTokens: maxLen ?? num(meta.n_ctx_train), sizeBytes: num(meta.size) }]
  })
  return { models, vllm }
}

// ---- Curated shortlist ----

export interface ShortlistModel {
  tag: string
  label: string
  /** Default (q4) pull size, bytes. Re-verify with the registry manifest at consent time. */
  approxBytes: number
  /** Model's own maximum context, tokens. */
  contextTokens: number
  /** Rough RAM/VRAM to run it comfortably. */
  minRamGB: number
  notes: string
  verifiedAt: string
}

const GB = 1e9
const VERIFIED = '2026-10-02'
const entry = (
  tag: string,
  label: string,
  gb: number,
  contextTokens: number,
  minRamGB: number,
  notes: string,
): ShortlistModel => ({ tag, label, approxBytes: Math.round(gb * GB), contextTokens, minRamGB, notes, verifiedAt: VERIFIED })

// Tags checked in the Ollama library on 2026-10-02. Annotation quality (JSON
// output) is NOT benchmarked for any of them. phi4 is excluded: 16K context.
export const OLLAMA_SHORTLIST: ShortlistModel[] = [
  entry('qwen3.5:4b', 'Qwen 3.5 4B', 3.4, 256_000, 8, 'Smallest option; for modest laptops.'),
  entry('ministral-3:3b', 'Ministral 3 3B', 3.0, 256_000, 8, 'Smallest option; for modest laptops.'),
  entry('qwen3.5:9b', 'Qwen 3.5 9B', 6.6, 256_000, 12, 'Good default for a 16 GB machine.'),
  entry('gemma4:e4b', 'Gemma 4 E4B', 6.6, 128_000, 12, 'Compact effective-4B model.'),
  entry('ministral-3:8b', 'Ministral 3 8B', 6.0, 256_000, 12, 'Mid-size general model.'),
  entry('gemma4:12b', 'Gemma 4 12B', 8.0, 256_000, 16, 'Mid-size general model.'),
  entry('ministral-3:14b', 'Ministral 3 14B', 9.1, 256_000, 16, 'Larger Ministral.'),
  entry('gpt-oss:20b', 'gpt-oss 20B', 14, 128_000, 24, 'Reasoning model with low/medium/high levels.'),
  entry('mistral-small3.2', 'Mistral Small 3.2', 15, 128_000, 24, 'Larger general model.'),
  entry('qwen3.6:27b', 'Qwen 3.6 27B', 17, 256_000, 32, 'Largest on the list; needs a workstation.'),
]
