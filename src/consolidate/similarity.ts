import type { FieldValue } from '../model/annotations'
import type { ResolvedDef } from '../model/schema'

/**
 * How alike two answers are, and how much that verdict is worth.
 *
 * `score` is 0..1. `weight` lets "agree on five fields" outrank "agree on
 * one" — averaging scores alone can't express that, since both average to 1.0.
 * Weight 0 means silence, not disagreement: a blank field must not drag a
 * match down, so only the fields both sides answered decide it.
 */
export interface Sim {
  score: number
  weight: number
}

/** The pair told us nothing — see {@link Sim}. */
export const NO_EVIDENCE: Sim = { score: 0, weight: 0 }

/**
 * Combine per-field verdicts into one: a weighted mean, plus the summed
 * weight so the parent verdict still knows how much evidence it rests on.
 */
export function combine(parts: Sim[]): Sim {
  let weight = 0
  let acc = 0
  for (const p of parts) {
    if (p.weight <= 0) continue
    weight += p.weight
    acc += p.score * p.weight
  }
  return weight === 0 ? NO_EVIDENCE : { score: acc / weight, weight }
}

/**
 * What the matcher maximises for one candidate pairing: score alone ignores
 * how much was compared, weight alone ignores agreement — the product favors
 * a group matching five fields over one matching a single field.
 */
export function agreementMass(sim: Sim): number {
  return sim.score * sim.weight
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Fold away the differences nobody means: case, surrounding space, repeated
 * space, and the punctuation reviewers sprinkle differently ("RCT." vs "RCT").
 */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[.,;:!?()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Levenshtein is O(len_a x len_b), and a reviewer can paste a paragraph. Past
 * this length edit distance is slow and meaningless, so `stringSimilarity`
 * falls back to word overlap only.
 */
const LEV_MAX_LEN = 256

/** Edit distance, computed on a single rolling row rather than a full matrix. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  const curr = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = curr.slice()
  }
  return prev[b.length]
}

/** Edit distance rescaled to 0..1, where 1 is identical. */
function levenshteinRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 1
  return 1 - levenshtein(a, b) / longest
}

/** Dice coefficient over word sets: how much of the vocabulary is shared. */
function tokenDice(a: string, b: string): number {
  const setA = new Set(a.split(' ').filter(Boolean))
  const setB = new Set(b.split(' ').filter(Boolean))
  if (setA.size === 0 || setB.size === 0) return 0
  let shared = 0
  for (const w of setA) if (setB.has(w)) shared++
  return (2 * shared) / (setA.size + setB.size)
}

/**
 * Every text comparison made during one alignment, keyed on the pair of values.
 *
 * Keyed on text, not entry identity: reviewers annotating one paper repeat the
 * same short answers across entries, so the same string pair recurs often.
 * Measured on a punishing case (5 reviewers, 12 entries/node, nested groups):
 * ~2.3s of comparisons drops to ~270ms cached.
 *
 * A plain Map, deliberately: it lives only for one alignment run, so it can't
 * grow unbounded or go stale.
 */
export type TextSimCache = Map<string, number>

/**
 * Separator for the pair cache key, length-prefixed so the key is unambiguous.
 *
 * A bare separator isn't safe: any value containing it can make two different
 * pairs collide on the same key, silently reusing one pair's cached score for
 * the other (measured: identical strings then scored 0.2 instead of 1.0). NUL
 * can reach an annotation via a hand-edited project file, a paste, or PDF
 * extraction.
 */
const KEY_SEP = '\u0000'

/**
 * How alike two free-text answers are, 0..1. Neither measure subsumes the
 * other, so the more forgiving wins: edit distance handles typos/inflections
 * but collapses on reordering; word overlap survives reordering but misses a
 * typo in a one-word answer. Both are blind to meaning ("RCT" vs "randomised
 * trial" scores 0).
 */
export function stringSimilarity(rawA: string, rawB: string, cache?: TextSimCache): number {
  if (!cache) return computeStringSimilarity(rawA, rawB)
  // One key per unordered pair: the measure is symmetric.
  const [lo, hi] = rawA < rawB ? [rawA, rawB] : [rawB, rawA]
  const key = `${lo.length}${KEY_SEP}${lo}${hi}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const score = computeStringSimilarity(rawA, rawB)
  cache.set(key, score)
  return score
}

function computeStringSimilarity(rawA: string, rawB: string): number {
  const a = normalizeText(rawA)
  const b = normalizeText(rawB)
  if (a === b) return 1
  if (a === '' || b === '') return 0

  const dice = tokenDice(a, b)
  if (a.length > LEV_MAX_LEN || b.length > LEV_MAX_LEN) return dice
  return Math.max(levenshteinRatio(a, b), dice)
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** True when a value carries no answer, by the same rule the validator uses. */
function blank(value: FieldValue | undefined): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

/**
 * How alike one field's two answers are. Type-aware, since each type fails
 * differently:
 *
 * - **enum**: compared as labels, never text — "High" and "Low" share most
 *   characters but mean the opposite, so edit distance would near-match them.
 * - **boolean**: only counts if at least one side ticked it, since every
 *   unticked box reads `false` and scoring that as agreement would swamp the
 *   real signal (same trap `annotationText` avoids for annotation search).
 * - **number**: scored by relative closeness (40 vs 41 is near-agreement, 40
 *   vs 4000 isn't).
 * - **year**: an identity, not a magnitude — 1999 and 2999 share three digits
 *   but aren't "close"; it either matches exactly or it doesn't.
 */
export function valueSimilarity(
  def: ResolvedDef,
  a: FieldValue | undefined,
  b: FieldValue | undefined,
  cache?: TextSimCache,
): Sim {
  if (def.type === 'boolean') {
    const ticked = a === true || b === true
    if (!ticked) return NO_EVIDENCE
    return { score: a === b ? 1 : 0, weight: 1 }
  }

  // One side silent: the field cannot speak to whether these are the same
  // entry, so it abstains rather than voting against.
  if (blank(a) || blank(b)) return NO_EVIDENCE

  if (def.options && def.options.length > 0) {
    return { score: normalizeText(String(a)) === normalizeText(String(b)) ? 1 : 0, weight: 1 }
  }

  if (def.type === 'year') {
    return { score: a === b ? 1 : 0, weight: 1 }
  }

  if (def.type === 'number') {
    const x = Number(a)
    const y = Number(b)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return NO_EVIDENCE
    if (x === y) return { score: 1, weight: 1 }
    const scale = Math.max(Math.abs(x), Math.abs(y), 1)
    return { score: Math.max(0, 1 - Math.abs(x - y) / scale), weight: 1 }
  }

  return { score: stringSimilarity(String(a), String(b), cache), weight: 1 }
}
