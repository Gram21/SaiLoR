import type { FieldValue } from '../model/annotations'
import type { FieldTarget } from './fields'
import { oneLine } from './prompt'
import { join, baseOf } from './providers'
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
/** Derived from `maxStateTokens` (default 200k chars, ~50k tokens at 4 chars/token). */
const DEFAULT_MAX_STATE_CHARS = 200_000
const TRUNCATION_MARK = '\n[truncated]'

interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria?: { true: string; false: string }
}

interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}

type SystemOneQuestion = NoulQuestion | ChoiceQuestion

function instructionsFor(target: FieldTarget): string {
  const bits = [target.def.name]
  if (target.def.description) bits.push(target.def.description)
  return oneLine(bits.join(' — ')).slice(0, MAX_INSTRUCTION_CHARS)
}

function questionFor(kind: 'noul' | 'choice', target: FieldTarget): SystemOneQuestion {
  const instructions = instructionsFor(target)
  if (kind === 'noul') return { type: 'noul', instructions }

  const criteria: Record<string, string> = {}
  for (const option of target.def.options ?? []) {
    criteria[option] = oneLine(option)
  }
  return { type: 'choice', instructions, criteria }
}

function buildState(
  paper: { title: string; abstract?: string },
  paperText: string,
  maxStateChars: number,
): string {
  const head = [paper.title, paper.abstract ?? ''].filter(Boolean).join('\n\n')
  const full = [head, paperText].filter(Boolean).join('\n\n')
  if (full.length <= maxStateChars) return full
  return full.slice(0, maxStateChars) + TRUNCATION_MARK
}

/** Builds a `/v1/systemone` request for every eligible target. Returns null when none qualify. */
/** One question sent, mapped back to its field. `options` is set for choice questions. */
export interface SystemOneAsked {
  id: string
  path: string
  kind: 'noul' | 'choice'
  options?: string[]
}

export function buildSystemOneRequest(
  cfg: LlmConfig & { maxStateTokens?: number },
  paper: { title: string; abstract?: string },
  paperText: string,
  targets: FieldTarget[],
  opts?: { maxStateChars?: number },
): { request: LlmHttpRequest; asked: SystemOneAsked[] } | null {
  const asked: SystemOneAsked[] = []
  const questions: Record<string, SystemOneQuestion> = {}

  targets.forEach((target, i) => {
    const kind = systemOneEligible(target)
    if (!kind) return
    const id = `q${i}`
    asked.push({ id, path: target.path, kind, ...(kind === 'choice' ? { options: target.def.options ?? [] } : {}) })
    questions[id] = questionFor(kind, target)
  })

  if (asked.length === 0) return null

  const maxStateChars =
    opts?.maxStateChars ?? (cfg.maxStateTokens ? cfg.maxStateTokens * 4 : DEFAULT_MAX_STATE_CHARS)
  const state = buildState(paper, paperText, maxStateChars)

  const request: LlmHttpRequest = {
    configId: cfg.id,
    url: join(baseOf(cfg), '/v1/systemone'),
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${API_KEY_SENTINEL}`,
    },
    body: JSON.stringify({
      model: cfg.model || 'jev-latest',
      state,
      questions,
    }),
  }

  return { request, asked }
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

  const answers = isRecord(json) && isRecord(json.answers) ? json.answers : {}

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

  const usage = isRecord(json) && isRecord(json.usage) ? json.usage : {}
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0

  return { suggestions, skipped, probabilities, usage: { inputTokens, outputTokens } }
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
  return {
    configId: cfg.id,
    url: join(baseOf(cfg), '/v1/systemone'),
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${API_KEY_SENTINEL}`,
    },
    body: JSON.stringify({
      model: cfg.model || 'jev-latest',
      state: 'This is a connectivity test.',
      questions: { q0: { type: 'noul', instructions: 'Is this a connectivity test?' } },
    }),
  }
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
