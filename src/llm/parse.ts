import type { ResolvedDef } from '../model/schema'
import type { FieldValue } from '../model/annotations'
import type { LlmAnswer, RejectedSuggestion, SkippedField, Suggestion } from './types'
import { parsePath, resolvePath, MAX_UNBOUNDED_INDEX } from './paths'
import { isPlausibleYear } from '../model/year'

/**
 * Turning a model's answer into `Suggestion[]` is the trust boundary of the AI
 * feature: everything downstream (the review table, the apply step) assumes the
 * suggestions it gets already fit the schema. So the rule here is that nothing
 * enters `fields` unless it *typechecks* against its `ResolvedDef` — a model that
 * ignores the contract must not be able to corrupt a reviewer's project.
 *
 * Where we bend, we bend only where models reliably misbehave in a way that has
 * exactly one honest reading: `"2021"` for a number field, `"true"` for a boolean,
 * `"randomized"` for the option `"Randomized"`. Everything else ("about 20", a
 * value that is not in the enum, a path that is not a field) is *rejected*, never
 * guessed at. Rejections are kept and shown, because a silently dropped answer
 * looks to the reviewer like the model never said anything.
 *
 * `parseAnswer` never throws: it sits on a network response, and unparseable
 * garbage is a normal outcome, not an exceptional one.
 */

/** Evidence is a quote for the reviewer to eyeball, not a document; keep rows readable. */
const MAX_EVIDENCE_CHARS = 500
const MAX_REASON_CHARS = 500
/** Prose before the JSON may contain stray braces; try a few starts, then give up. */
const MAX_BRACE_CANDIDATES = 8

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

// Models wrap the object in a ```json fence roughly half the time, and both the
// language tag and the closing fence are frequently missing or misspelled.
const FENCE = /```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)(?:```|$)/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The `{...}` starting at `from`, or null when it never closes.
 *
 * A regex cannot do this: `/\{[\s\S]*\}/` happily swallows trailing commentary,
 * and any non-greedy variant stops at the first `}` — which in a real answer is
 * usually one that sits *inside* a quoted evidence string. So we scan, and the
 * scan has to know about string literals and their escapes.
 */
function matchBraces(text: string, from: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = from; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return null
}

/** First balanced `{...}` in the text that parses as a JSON object. */
function scanForObject(text: string): Record<string, unknown> | null {
  let tried = 0
  for (let i = 0; i < text.length && tried < MAX_BRACE_CANDIDATES; i++) {
    if (text[i] !== '{') continue
    const span = matchBraces(text, i)
    if (!span) continue
    tried++
    const obj = tryParseObject(span)
    if (obj) return obj
  }
  return null
}

/** Dig the answer object out of whatever the model actually sent. */
function extractObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null

  // The happy path: the model did what it was told.
  const direct = tryParseObject(text)
  if (direct) return direct

  const fenced = FENCE.exec(text)?.[1]?.trim()
  if (fenced) {
    const obj = tryParseObject(fenced) ?? scanForObject(fenced)
    if (obj) return obj
  }

  return scanForObject(text)
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

type Coerced = { ok: true; value: FieldValue } | { ok: false; reason: string }

function toNumber(raw: unknown): Coerced {
  if (typeof raw === 'number') {
    // NaN and ±Infinity cannot come out of JSON.parse, but a hand-built object can carry them.
    return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false, reason: 'not a number' }
  }
  if (typeof raw === 'string') {
    const text = raw.trim()
    // A decimal number, optionally signed, optionally in scientific notation —
    // and nothing else. `Number()` alone is far more permissive than this
    // module's contract: it reads '0x20' as 32, '0b101' as 5, '0o17' as 15 and
    // '' as 0, none of which is "exactly one honest reading" of what a paper
    // says. A paper does not write a sample size in hexadecimal, so accepting
    // it silently records a number nobody wrote. Rejections are shown to the
    // reviewer, so over-rejecting costs a visible row while over-accepting
    // costs invisible wrong data.
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) {
      const n = Number(text)
      if (Number.isFinite(n)) return { ok: true, value: n }
    }
  }
  return { ok: false, reason: 'not a number' }
}

function toBoolean(raw: unknown): Coerced {
  if (typeof raw === 'boolean') return { ok: true, value: raw }
  if (typeof raw === 'string') {
    // Python-flavoured "True"/"False" is common enough to be worth folding case.
    const text = raw.trim().toLowerCase()
    if (text === 'true') return { ok: true, value: true }
    if (text === 'false') return { ok: true, value: false }
  }
  return { ok: false, reason: 'not a boolean' }
}

/**
 * An enum value must end up *exactly* on one of the options — the dropdown and
 * every downstream grouping compare by string equality. We snap a case- or
 * whitespace-off answer onto its canonical option because that is a spelling
 * difference, not a different answer; a value that matches no option at all is
 * rejected rather than fuzzily matched to the nearest one.
 */
function toOption(raw: string, options: string[]): Coerced {
  if (options.includes(raw)) return { ok: true, value: raw }

  const folded = raw.toLowerCase()
  const snapped = options.find((o) => o.trim().toLowerCase() === folded)
  if (snapped !== undefined) return { ok: true, value: snapped }

  return { ok: false, reason: 'not an allowed value' }
}

function toString(raw: unknown, def: ResolvedDef): Coerced {
  // A number or boolean for a string field means the model answered a different
  // question than the one we asked; we have no way to know which.
  if (typeof raw !== 'string') return { ok: false, reason: 'not a string' }
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'empty value' }
  if (def.options && def.options.length > 0) return toOption(text, def.options)
  return { ok: true, value: text }
}

/** Like `toNumber`, plus the range check that makes this a *year* rather than
 *  any number — a model that answers `55` or `20221` has misread the paper,
 *  not found an unusual year, so that is rejected rather than accepted and
 *  handed on for a human to puzzle over. */
function toYear(raw: unknown): Coerced {
  const n = toNumber(raw)
  if (!n.ok) return n
  return isPlausibleYear(n.value) ? n : { ok: false, reason: 'not a plausible publication year' }
}

function coerce(def: ResolvedDef, raw: unknown): Coerced {
  switch (def.type) {
    case 'string':
      return toString(raw, def)
    case 'number':
      return toNumber(raw)
    case 'boolean':
      return toBoolean(raw)
    case 'year':
      return toYear(raw)
    default:
      // resolvePath only ever returns field defs, so this is unreachable in practice.
      return { ok: false, reason: 'unknown field' }
  }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function toEvidence(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim().slice(0, MAX_EVIDENCE_CHARS)
  // A stringified object or array would be noise, not a quote — drop it instead.
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return ''
}

/**
 * Confidence outside 0..1 is dropped, not clamped down into range. A model that
 * answers `95` may mean percent, or a 1..100 scale, or nothing at all; folding
 * that to `1` would invent a near-certainty the model never claimed. `null`
 * ("it gave none or gave nonsense") is the honest reading, and the UI already
 * handles it. Values inside the range are clamped, which only matters for float
 * noise such as `1.0000000001`.
 */
function toConfidence(raw: unknown): number | null {
  // An empty or whitespace-only string is *not* a confidence of zero.
  // `Number('')` is 0, which sits inside the valid range, so a model that sent
  // an empty confidence had "0%" rendered against its answer — a claim of
  // total uncertainty it never made, which is exactly the invention the
  // paragraph above says to avoid.
  if (typeof raw === 'string' && raw.trim() === '') return null
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
  if (!Number.isFinite(n) || n < 0 || n > 1) return null
  return Math.min(1, Math.max(0, n))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function asArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : []
}

/**
 * Validate one raw answer against the schema.
 *
 * Never throws. An answer we cannot make sense of at all yields an empty result;
 * an answer we can read but do not accept yields entries in `rejected`.
 */
export function parseAnswer(schema: ResolvedDef[], raw: string): LlmAnswer {
  const fields: Suggestion[] = []
  const skipped: SkippedField[] = []
  const rejected: RejectedSuggestion[] = []
  const answer: LlmAnswer = { fields, skipped, rejected }

  const root = extractObject(raw)
  if (!root) return answer

  const defs = Array.isArray(schema) ? schema : []
  // Keyed by canonical path, so "Year" and "Year[0]" count as the same field.
  const seen = new Set<string>()

  for (const entry of asArray(root.fields)) {
    if (!isPlainObject(entry)) {
      rejected.push({ path: '', raw: entry, reason: 'malformed entry' })
      continue
    }

    const rawPath = typeof entry.path === 'string' ? entry.path.trim() : ''
    const resolved = rawPath === '' ? null : resolvePath(defs, rawPath, { maxUnboundedIndex: MAX_UNBOUNDED_INDEX })
    if (!resolved) {
      // resolvePath already covers unknown names, group paths, out-of-range
      // indices and bad syntax; the reviewer only needs to know we refused it.
      rejected.push({ path: rawPath, raw: entry.value, reason: 'unknown field' })
      continue
    }

    const path = resolved.canonical

    if (seen.has(path)) {
      // Two answers for one field: the model contradicted itself. Picking either
      // one is guesswork, so we keep the first and show the reviewer the rest.
      rejected.push({ path, raw: entry.value, reason: 'duplicate' })
      continue
    }

    if (!('value' in entry) || entry.value === undefined) {
      rejected.push({ path, raw: entry.value, reason: 'missing value' })
      continue
    }

    const result = coerce(resolved.def, entry.value)
    if (!result.ok) {
      rejected.push({ path, raw: entry.value, reason: result.reason })
      continue
    }

    seen.add(path)
    fields.push({
      path,
      value: result.value,
      evidence: toEvidence(entry.evidence),
      confidence: toConfidence(entry.confidence),
    })
  }

  for (const entry of asArray(root.skipped)) {
    if (!isPlainObject(entry)) continue
    const path = typeof entry.path === 'string' ? entry.path.trim() : ''
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : ''
    // Skips are shown, never applied, so a path that merely *looks* like a path
    // is good enough here — no need to hold them to the schema.
    if (path === '' || reason === '' || !parsePath(path)) continue
    skipped.push({ path, reason: reason.slice(0, MAX_REASON_CHARS) })
  }

  return answer
}
