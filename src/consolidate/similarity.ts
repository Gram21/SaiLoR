import type { FieldValue } from '../model/annotations'
import type { ResolvedDef } from '../model/schema'

/**
 * How alike two answers are, and how much that verdict is worth.
 *
 * `score` is 0..1. `weight` is how much evidence the verdict rests on, and it
 * is what makes "these two groups agree on five fields" outrank "these two
 * agree on one" — the ranking the matcher is asked to produce. Averaging
 * scores alone cannot express that: one field matched perfectly and five
 * fields matched perfectly both average to 1.0.
 *
 * Weight 0 means the pair said nothing either way. Absence of an answer is not
 * disagreement, so it must not drag a match down: if one reviewer left a field
 * blank, that field is silent about whether these two entries are the same
 * thing, and the fields they *both* answered decide it.
 */
export interface Sim {
  score: number
  weight: number
}

/** The pair told us nothing — see {@link Sim}. */
export const NO_EVIDENCE: Sim = { score: 0, weight: 0 }

/**
 * Combine per-field verdicts into one. The mean is weighted (so a field with
 * more evidence behind it counts for more), while the total weight carries
 * forward, so a parent group's own verdict still knows how much it rests on.
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
 * What the matcher maximises for one candidate pairing.
 *
 * Score alone would be blind to how much was compared; weight alone would
 * ignore whether the answers actually agree. The product is "how much agreement
 * this pairing buys", which is the quantity a total-agreement-maximising
 * assignment needs — and it is what gives a group matching five fields
 * priority over one matching a single field.
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
 * Levenshtein is O(len_a x len_b); annotation values are usually a phrase but
 * nothing stops a reviewer pasting a paragraph. Past this length the character
 * edit distance is both slow and meaningless — whole-word overlap is the only
 * signal that still says anything — so `stringSimilarity` skips it there.
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
 * Where nearly all the matcher's time goes, and the one cache that pays. The
 * entries being compared are all distinct objects, so memoising on the entry
 * pair collects nothing — measured, it changed the runtime by less than the
 * noise. The repetition is in the *text*: reviewers annotating one paper write
 * many of the same short answers, so the same two strings are compared over and
 * over on behalf of different entries.
 *
 * Measured on a deliberately punishing paper (5 reviewers, 12 entries a node,
 * nested repeated groups): ~270,000 text comparisons at ~8us each, over a few
 * dozen distinct values — ~2.3s, essentially all of the runtime. Caching on the
 * value pair brings that to ~270ms. What remains is the matching itself rather
 * than the text.
 *
 * A plain Map, deliberately: it lives only for one alignment run and is dropped
 * with it, so it cannot grow unbounded or go stale.
 */
export type TextSimCache = Map<string, number>

/**
 * Joins a value pair into one cache key.
 *
 * Has to be a character that cannot appear in an annotation, or two different
 * pairs would share a key and one would silently answer for the other: with a
 * space, ("aa bb", "bb") and ("aa", "bb bb") both key to "aa bb bb". Written as
 * an escape rather than typed literally, so it survives an editor or a tool
 * that strips control characters from the source.
 */
/**
 * Separator for the pair cache key, with the first string's length in front of
 * it.
 *
 * The length prefix is what makes the key unambiguous. Joining with a separator
 * alone assumes the separator cannot occur inside a value, and no character
 * satisfies that: a value holding this one made two *different* pairs spell the
 * same key, so the second pair silently took the first one's cached score.
 * Measured: two identical strings scored 0.2 instead of 1.0, which in a
 * consolidation run means entries that match perfectly are aligned as though
 * they barely match — wrong, and invisible. A NUL reaches an annotation value
 * through a hand-edited project file (the format is meant to be hand-editable),
 * a paste, or PDF text extraction.
 */
const KEY_SEP = '\u0000'

/**
 * How alike two free-text answers are, 0..1.
 *
 * The two measures catch different mistakes and neither subsumes the other, so
 * the more forgiving one wins: edit distance handles typos and inflections
 * ("participant" vs "participants") but collapses when words are reordered,
 * while word overlap survives reordering and padding ("controlled experiment"
 * vs "a controlled experiment") but scores zero on a typo in a one-word answer.
 *
 * Both are blind to meaning — "RCT" and "randomised trial" score 0 here.
 */
export function stringSimilarity(rawA: string, rawB: string, cache?: TextSimCache): number {
  if (!cache) return computeStringSimilarity(rawA, rawB)
  // One key per unordered pair: the measure is symmetric, and the matcher asks
  // both ways round.
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
 * How alike one field's two answers are.
 *
 * Type-aware on purpose — the types fail in different ways:
 *
 * - An **enum** (`options`) is a closed set, so its members are compared as
 *   labels, never as text. "High" and "Low" share three of four characters and
 *   mean the opposite; letting edit distance near-match them would be worse
 *   than useless.
 * - A **boolean** only counts when at least one side ticked it. Every unticked
 *   box in the project reads `false`, so scoring `false`/`false` as agreement
 *   would make every pair of entries look alike and swamp the real signal —
 *   the same trap `annotationText` documents for annotation search.
 * - A **number** is scored by relative closeness, so 40 and 41 participants
 *   are near-agreement while 40 and 4000 are not.
 * - A **year** is an identity, not a magnitude: 1999 and 2999 are not "close",
 *   they are two different papers' publication years that happen to share
 *   three of four digits. Relative-closeness scoring (the `number` branch)
 *   would call that a near-match; falling through to `stringSimilarity`
 *   instead would score it via edit distance, which is exactly as wrong for
 *   the same reason. A year either matches or it doesn't.
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
