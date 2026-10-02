import type { FieldValue } from '../model/annotations'
import type { FieldTarget } from './fields'
import { oneLine } from './prompt'
import { join, baseOf } from './providers'
import { estimateTokens, fitPaperText } from './budget'
import { optionsBudgetOf, systemOneProfileFor } from './modelProfiles'
import type { LlmConfig, LlmHttpRequest, Suggestion } from './types'
import { API_KEY_SENTINEL } from './types'

/**
 * "System 1" decision models (TypeSafe Jev, convaiinnovations Laya via
 * `laya-serve`) answer one closed-form question at a time with a calibrated
 * probability instead of free text. Only fields with a small, fixed answer
 * space fit that contract:
 *
 * - a boolean field maps to `noul` (P(true))
 * - a single-valued enum (`string` with 2-255 `options`) maps to `choice`
 *
 * Anything else (free text, number, year, or an enum with 0/1/256+ options)
 * has no closed answer space, so it is not eligible.
 */
export function systemOneEligible(target: FieldTarget): 'noul' | 'choice' | null {
  const { def } = target
  if (def.type === 'boolean') return 'noul'
  if (def.type === 'string' && def.options && def.options.length >= 2 && def.options.length <= 255) {
    return 'choice'
  }
  return null
}

const MAX_INSTRUCTION_CHARS = 500

export interface NoulQuestion {
  type: 'noul'
  instructions: string
}

export interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion

function instructionsFor(target: FieldTarget): string {
  const bits = [target.def.name]
  if (target.def.description) bits.push(target.def.description)
  return oneLine(bits.join(' — ')).slice(0, MAX_INSTRUCTION_CHARS)
}

function questionFor(kind: 'noul' | 'choice', instructions: string, options: string[]): SystemOneQuestion {
  if (kind === 'noul') return { type: 'noul', instructions }
  const criteria: Record<string, string> = {}
  for (const option of options) criteria[option] = oneLine(option)
  return { type: 'choice', instructions, criteria }
}

/** One question sent, mapped back to its field. `options` is set for choice questions. */
export interface SystemOneAsked {
  id: string
  path: string
  kind: 'noul' | 'choice'
  options?: string[]
}

// ---------------------------------------------------------------------------
// Planning: endpoint, packing, state composition
// ---------------------------------------------------------------------------

const CF_ACCOUNT_ID = /^[a-f0-9]{32}$/
const SAFETY_TOKENS = 16
/** Per-question markers the server adds around instruction and options. */
const QUESTION_MARKER_TOKENS = 4
/** Below this state budget a body slice is too small to be useful: title + abstract only. */
const MIN_BODY_STATE_TOKENS = 2000

/** URL + model for a System One target; `error` when the config cannot form one. */
export function systemOneEndpoint(cfg: LlmConfig): { url: string; model: string } | { error: string } {
  if (cfg.systemOneFlavor !== 'cloudflare') {
    return { url: join(baseOf(cfg), '/v1/systemone'), model: cfg.model || 'jev-latest' }
  }
  const account = cfg.accountId?.trim() ?? ''
  if (!CF_ACCOUNT_ID.test(account)) {
    return { error: 'Cloudflare account id must be 32 lowercase hex characters (see the Cloudflare dashboard).' }
  }
  const model = (cfg.model || 'clef-flash').replace(/^@cf\/cloudflare\//, '')
  if (model !== 'clef' && model !== 'clef-flash') {
    return { error: `Cloudflare Workers AI serves "clef" and "clef-flash", not "${model}".` }
  }
  return { url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${model}`, model }
}

function wireRequest(cfg: LlmConfig, ep: { url: string; model: string }, state: string, questions: unknown): LlmHttpRequest {
  return {
    configId: cfg.id,
    url: ep.url,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${API_KEY_SENTINEL}` },
    body: JSON.stringify({ model: ep.model, state, questions }),
  }
}

/** A candidate question; `short` is the fallback when the full wording exceeds the budget. */
export interface SystemOneItem extends SystemOneAsked {
  question: SystemOneQuestion
  short?: SystemOneQuestion
}

export interface SystemOneStateInput {
  /** Title, abstract and metadata: always sent first. */
  head: string
  hasAbstract: boolean
  /** Extracted paper text; '' when none. */
  body: string
}

export interface SystemOnePlan {
  requests: { request: LlmHttpRequest; asked: SystemOneAsked[] }[]
  notHandled: { path: string; reason: string }[]
  state: { truncated: boolean; chars: number; mode: 'abstract-only' | 'abstract+body' | 'full' }
  /** Set when the config cannot form a request at all (e.g. a bad Cloudflare account id). */
  error?: string
}

const MODE_RANK = { full: 0, 'abstract+body': 1, 'abstract-only': 2 } as const

function composeState(input: SystemOneStateInput, budget: number): { text: string; truncated: boolean; mode: SystemOnePlan['state']['mode'] } {
  const whole = [input.head, input.body].filter(Boolean).join('\n\n')
  if (estimateTokens(whole) <= budget) return { text: whole, truncated: false, mode: 'full' }

  const cut = (t: string) => {
    let out = t.slice(0, Math.max(0, Math.floor(budget * 3.2)))
    while (estimateTokens(out) > budget) out = out.slice(0, -1)
    return out
  }
  if (budget < MIN_BODY_STATE_TOKENS) {
    // Body text would be sliced to garbage; with no abstract, take what fits of the body.
    if (input.hasAbstract || !input.body) return { text: cut(input.head), truncated: true, mode: 'abstract-only' }
    return { text: cut(whole), truncated: true, mode: 'abstract+body' }
  }
  const head = cut(input.head)
  const fitted = fitPaperText(input.body, budget - estimateTokens(head) - 2)
  return { text: [head, fitted.text].filter(Boolean).join('\n\n'), truncated: true, mode: 'abstract+body' }
}

/**
 * Plans every `/v1/systemone` request needed for `items`: label checks against
 * the model's profile, greedy packing into as few requests as `maxQuestions`
 * allows, and a state sized to what is left of the window.
 */
export function planSystemOne(
  cfg: LlmConfig & { maxStateTokens?: number },
  items: SystemOneItem[],
  stateInput: SystemOneStateInput,
): SystemOnePlan {
  const profile = systemOneProfileFor(cfg)
  const limit = optionsBudgetOf(profile)
  const empty: SystemOnePlan['state'] = { truncated: false, chars: 0, mode: 'full' }
  const ep = systemOneEndpoint(cfg)
  if ('error' in ep) {
    return { requests: [], notHandled: items.map((i) => ({ path: i.path, reason: ep.error })), state: empty, error: ep.error }
  }

  const notHandled: { path: string; reason: string }[] = []
  const fit: { item: SystemOneItem; question: SystemOneQuestion; head: number }[] = []
  const model = cfg.model || 'this model'
  for (const item of items) {
    if (item.options && item.options.length > profile.maxOptionsPerChoice) {
      notHandled.push({ path: item.path, reason: `too many options for ${model}: use an LLM` })
      continue
    }
    const tokens = (q: SystemOneQuestion) => estimateTokens(JSON.stringify(q))
    let question = item.question
    if (tokens(question) + QUESTION_MARKER_TOKENS > limit && item.short) question = item.short
    if (tokens(question) + QUESTION_MARKER_TOKENS > limit) {
      notHandled.push({ path: item.path, reason: "labels too long for this model's input window" })
      continue
    }
    fit.push({ item, question, head: tokens(question) + QUESTION_MARKER_TOKENS })
  }

  // Laya-style budgets are shared by all questions of a request, so head tokens
  // are summed; without an explicit options budget (Jev/Clef) the longest counts.
  const summed = profile.optionsBudgetTokens !== undefined
  // ponytail: greedy in input order; grouping by question size would free a bit more state.
  const groups: (typeof fit)[] = []
  let used = 0
  for (const f of fit) {
    const last = groups[groups.length - 1]
    if (last && last.length < profile.maxQuestions && (!summed || used + f.head <= limit)) {
      last.push(f)
      used += f.head
    } else {
      groups.push([f])
      used = f.head
    }
  }

  const state: SystemOnePlan['state'] = { ...empty }
  const requests = groups.map((group) => {
    const heads = group.map((g) => g.head)
    const head = summed ? heads.reduce((n, h) => n + h, 0) : Math.max(...heads)
    let budget = profile.contextTokens - head - SAFETY_TOKENS
    if (cfg.maxStateTokens) budget = Math.min(budget, cfg.maxStateTokens)
    const composed = composeState(stateInput, Math.max(0, budget))
    if (composed.truncated) state.truncated = true
    if (MODE_RANK[composed.mode] > MODE_RANK[state.mode]) state.mode = composed.mode
    state.chars = Math.max(state.chars, composed.text.length)
    const questions = Object.fromEntries(group.map((g) => [g.item.id, g.question]))
    const asked: SystemOneAsked[] = group.map(({ item: { id, path, kind, options } }) => ({
      id,
      path,
      kind,
      ...(kind === 'choice' ? { options } : {}),
    }))
    return { request: wireRequest(cfg, ep, composed.text, questions), asked }
  })
  return { requests, notHandled, state }
}

/** Plans System One requests for the eligible `targets`; the ineligible ones are left to the caller. */
export function planSystemOneRequests(
  cfg: LlmConfig & { maxStateTokens?: number },
  paper: { title: string; abstract?: string; keywords?: string[]; venue?: string; year?: number },
  paperText: string,
  targets: FieldTarget[],
): SystemOnePlan {
  const items: SystemOneItem[] = []
  targets.forEach((target, i) => {
    const kind = systemOneEligible(target)
    if (!kind) return
    const options = target.def.options ?? []
    items.push({
      id: `q${i}`,
      path: target.path,
      kind,
      ...(kind === 'choice' ? { options } : {}),
      question: questionFor(kind, instructionsFor(target), options),
      short: questionFor(kind, oneLine(target.def.name).slice(0, MAX_INSTRUCTION_CHARS), options),
    })
  })
  const meta = [
    paper.keywords?.length ? `Keywords: ${paper.keywords.join(', ')}` : '',
    [paper.venue, paper.year].filter(Boolean).join(' '),
  ].filter(Boolean)
  const head = [paper.title, paper.abstract ?? '', ...meta].filter(Boolean).join('\n\n')
  return planSystemOne(cfg, items, { head, hasAbstract: !!paper.abstract, body: paperText })
}

/** Backward-compatible: the first planned request, or null when nothing is eligible/handled. */
export function buildSystemOneRequest(
  cfg: LlmConfig & { maxStateTokens?: number },
  paper: { title: string; abstract?: string },
  paperText: string,
  targets: FieldTarget[],
): { request: LlmHttpRequest; asked: SystemOneAsked[] } | null {
  return planSystemOneRequests(cfg, paper, paperText, targets).requests[0] ?? null
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export interface SystemOneResult {
  suggestions: Suggestion[]
  skipped: { path: string; reason: string }[]
  probabilities: Record<string, Record<string, number>>
  usage: { inputTokens: number; outputTokens: number }
}

/**
 * Validates a `/v1/systemone` reply against what was asked. Never throws:
 * junk in `json` (wrong shape, unknown answer type, an out-of-set choice)
 * simply skips that field, same posture as `parse.ts`'s trust boundary.
 */
export function parseSystemOneResponse(
  asked: SystemOneAsked[],
  json: unknown,
  opts?: { minConfidence?: number },
): SystemOneResult {
  const suggestions: Suggestion[] = []
  const skipped: { path: string; reason: string }[] = []
  const probabilities: Record<string, Record<string, number>> = {}
  const minConfidence = opts?.minConfidence ?? 0

  // Cloudflare Workers AI wraps the reply as { result: {...}, success, errors }.
  const body = isRecord(json) && isRecord(json.result) ? json.result : json
  const answers = isRecord(body) && isRecord(body.answers) ? body.answers : {}

  for (const { id, path, kind, options } of asked) {
    const answer = answers[id]
    if (!isRecord(answer)) {
      skipped.push({ path, reason: 'no answer returned' })
      continue
    }

    if (kind === 'noul') {
      const noul = answer.noul
      if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
        skipped.push({ path, reason: 'malformed answer' })
        continue
      }
      const confidence = Math.max(noul, 1 - noul)
      probabilities[path] = { true: noul, false: 1 - noul }
      if (confidence < minConfidence) {
        skipped.push({ path, reason: `low confidence (p=${confidence})` })
        continue
      }
      suggestions.push({
        path,
        value: noul >= 0.5,
        evidence: '',
        confidence,
        source: 'system-one',
      })
      continue
    }

    // choice
    const choice = answer.choice
    const probs = isRecord(answer.probabilities) ? answer.probabilities : {}
    if (typeof choice !== 'string') {
      skipped.push({ path, reason: 'malformed answer' })
      continue
    }
    const numericProbs: Record<string, number> = {}
    for (const [k, v] of Object.entries(probs)) {
      if (typeof v === 'number' && Number.isFinite(v)) numericProbs[k] = v
    }
    // The schema's options are the authority — never the reply's own keys.
    if (!(options ?? []).includes(choice)) {
      skipped.push({ path, reason: 'choice not among the offered options' })
      continue
    }
    if (Object.keys(numericProbs).length > 0) probabilities[path] = numericProbs

    const rawConfidence = answer.confidence
    const confidence =
      typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
        ? rawConfidence
        : (numericProbs[choice] ?? 0)

    if (confidence < minConfidence) {
      skipped.push({ path, reason: `low confidence (p=${confidence})` })
      continue
    }

    suggestions.push({
      path,
      value: choice,
      evidence: '',
      confidence,
      source: 'system-one',
    })
  }

  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {}
  const num = (...keys: string[]) => keys.map((k) => usage[k]).find((v): v is number => typeof v === 'number') ?? 0
  const inputTokens = num('input_tokens', 'prompt_tokens')
  const outputTokens = num('output_tokens', 'completion_tokens')

  return { suggestions, skipped, probabilities, usage: { inputTokens, outputTokens } }
}

/** Combines the results of several requests planned for one paper. */
export function mergeSystemOneResults(results: SystemOneResult[]): SystemOneResult {
  return {
    suggestions: results.flatMap((r) => r.suggestions),
    skipped: results.flatMap((r) => r.skipped),
    probabilities: Object.assign({}, ...results.map((r) => r.probabilities)),
    usage: {
      inputTokens: results.reduce((n, r) => n + r.usage.inputTokens, 0),
      outputTokens: results.reduce((n, r) => n + r.usage.outputTokens, 0),
    },
  }
}

// ---------------------------------------------------------------------------
// Cross-checking an LLM's proposal against System One
// ---------------------------------------------------------------------------

export interface SystemOneComparison {
  agrees: boolean
  s1Value: FieldValue
  p: number
}

/**
 * Cross-checks each of an LLM's `suggestions` against the matching System One
 * answer in `s1` (by path). Booleans compare exactly; enum choices compare
 * case-insensitively (System 1's `choice` is expected verbatim, but a
 * generative model's proposal may differ only in case). Paths System One
 * has no suggestion for are absent from the result.
 */
/** What "Verify setup" asks and expects back — a single throwaway noul question. */
export const SYSTEMONE_VERIFY_ASKED: SystemOneAsked[] = [{ id: 'q0', path: 'verify', kind: 'noul' }]

/** The minimal request "Verify setup" sends for a System One target: one tiny
 *  noul question, so a bad key/model/URL surfaces here rather than mid-run. */
export function buildSystemOneVerifyRequest(cfg: LlmConfig): LlmHttpRequest {
  const ep = systemOneEndpoint(cfg)
  if ('error' in ep) throw new Error(ep.error)
  return wireRequest(cfg, ep, 'This is a connectivity test.', {
    q0: { type: 'noul', instructions: 'Is this a connectivity test?' },
  })
}

export function compareWithSystemOne(
  suggestions: Suggestion[],
  s1: SystemOneResult,
): Map<string, SystemOneComparison> {
  const byPath = new Map(s1.suggestions.map((s) => [s.path, s]))
  const out = new Map<string, SystemOneComparison>()

  for (const suggestion of suggestions) {
    const s1Suggestion = byPath.get(suggestion.path)
    if (!s1Suggestion) continue

    const probs = s1.probabilities[suggestion.path]
    let agrees: boolean
    let p: number

    if (typeof suggestion.value === 'boolean' && typeof s1Suggestion.value === 'boolean') {
      agrees = suggestion.value === s1Suggestion.value
    } else {
      const a = String(suggestion.value).trim().toLowerCase()
      const b = String(s1Suggestion.value).trim().toLowerCase()
      agrees = a === b
    }
    // Always System One's own confidence in *its* answer (`s1Value`), not in
    // whatever the suggestion claimed — so a caller can read `p` the same way
    // whether this agrees or not (e.g. "classifier says X, p=0.9").
    p = probs?.[String(s1Suggestion.value)] ?? (s1Suggestion.confidence ?? 0)

    out.set(suggestion.path, { agrees, s1Value: s1Suggestion.value, p })
  }

  return out
}
