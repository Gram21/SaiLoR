import { normalizeText, stringSimilarity } from '../consolidate/similarity'

/**
 * Flag probable duplicate papers at import time, reusing `consolidate/similarity`'s
 * lexical matcher rather than inventing a second one (see that module for the
 * shared scoring primitives, and its own documented ceiling: this is lexical
 * matching, so "RCT" and "randomised controlled trial" still score low — fine
 * for titles, which is what this compares).
 *
 * Pure and store-free by design: it knows nothing of `EditorPaper`, the DOM, or
 * React. The caller (`editorStore.ts`) adapts its own paper/reference shapes
 * into `DupRecord` and turns a `DupVerdict` into an actual store mutation.
 */

/** The minimal bibliographic shape this module reasons about. Deliberately not
 *  `EditorPaper` or `RefEntry` — this module must not know either exists. */
export interface DupRecord {
  title: string
  authors: string[]
  doi?: string
  /** Optional because a real bibliographic record often has no year at all (a
   *  reference export that omitted it, a paper added by PDF alone). A record
   *  missing it never blocks a match on that account — see `YEAR_GAP_VETO` —
   *  it just can't corroborate or veto one either. */
  year?: number
}

export type DupTarget = { where: 'existing'; index: number } | { where: 'batch'; index: number }

export type DupReason =
  | { via: 'doi' }
  | { via: 'title'; score: number }
  | { via: 'base-title'; score: number; authors: number }

export type DupVerdict =
  | { kind: 'new' }
  | { kind: 'certain'; target: DupTarget; reason: DupReason }
  | { kind: 'probable'; target: DupTarget; reason: DupReason }

// ---------------------------------------------------------------------------
// Exact matching (today's behaviour, widened slightly and given a name)
// ---------------------------------------------------------------------------

/** Lowercased, whitespace-collapsed, punctuation-stripped — for matching titles
 *  across sources that differ only in casing/spacing/punctuation. Strips *all*
 *  punctuation (not just a fixed list), so an em-dash vs a hyphen, or a colon vs
 *  none, already collapse to the same string here — this is why those pairs
 *  reach the exact/certain path below rather than needing the fuzzy one. */
export function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lowercased and trimmed, with a leading `https://doi.org/`, `http://dx.doi.org/`,
 *  or `doi:` stripped — CSL-JSON routinely carries the URL form, and comparing
 *  it raw against a bare DOI would miss an identical record. */
export function normalizeDoi(doi: string | undefined): string {
  if (!doi) return ''
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * How alike two *whole* titles (or two subtitle-stripped *base* titles) must
 * score, via `stringSimilarity`, to count as a probable duplicate.
 *
 * Measured against real title pairs (see `duplicates.test.ts` for the exact
 * strings), whole-title similarity alone cannot be separated by a single
 * threshold — the different-paper and same-paper classes interleave:
 *
 * | pair | sim | truth |
 * |---|---|---|
 * | "...Part I" / "...Part II" | 0.978 | different |
 * | British/American spelling | 0.952 | same |
 * | "...for Java" / "...for Python" | 0.878 | different |
 * | same-domain surveys (different domains) | 0.857 | different |
 * | a typo | 0.973 | same |
 *
 * 0.90 sits above every measured different-paper pair except the "Part I/II"
 * one, and below every measured same-paper pair whose *whole* title actually
 * differs (a present/absent subtitle scores lower still — 0.667–0.80 in the
 * same measurements — which is why the base-title/author rule below exists
 * separately rather than by lowering this number). Lowering it to catch
 * "Part I/II" would also catch "for Java"/"for Python" and the same-domain
 * surveys — trading one rare false positive for two common ones. "Part I/II"
 * is accepted as a known false positive: it costs one click in the review
 * dialog, pinned by a test so a future change to this number is a conscious one.
 */
const TITLE_SIM_THRESHOLD = 0.9

/**
 * How alike two papers' *surname sets* (Dice coefficient) must score to
 * corroborate a base-title match — see `classifyPair`'s base-title rule.
 *
 * Base-title equality alone is not enough: "Software Testing: A Survey" and
 * "Software Testing: An Introduction" share a base title and are two different
 * papers. Requiring some author overlap catches that, but reference-manager
 * exports routinely truncate author lists ("et al."), so the bar has to
 * tolerate a large recorded list matching a short one. Measured: a 3-author
 * list against a 1-author list that shares exactly one name scores exactly
 * 0.50 — set deliberately at that bar, not above it, so a truncated-but-real
 * match still counts. A pair sharing only one of three names *each* (no
 * truncation, genuinely mostly-different author lists) scores 0.33 and stays
 * below it.
 */
const AUTHOR_SIM_THRESHOLD = 0.5

/**
 * A year gap this large or larger, on an otherwise title-matching pair, means
 * "different artifact" (a workshop paper and its journal extension share a
 * title and are both worth citing separately in an SLR) rather than "database
 * disagreement" — so it downgrades what would otherwise be a certain or
 * probable match all the way to `new`.
 *
 * Not `!==`: databases disagree by one year constantly (online-first vs. issue
 * date), and treating that routine noise as a different paper would be a much
 * more common false negative than the workshop/journal case is a false
 * positive. Never applied to a DOI match — an identical DOI is the same
 * record whatever year two databases happen to claim for it.
 */
const YEAR_GAP_VETO = 2

// ---------------------------------------------------------------------------
// Author surnames
// ---------------------------------------------------------------------------

/** Diacritic-fold: "José" and "Jose" must land on the same surname, or an
 *  accented name typed two different ways would abstain instead of matching. */
function foldDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * The surname of one author's recorded name, folded for comparison.
 *
 * Handles "Last, First" *before* stripping punctuation — stripping first and
 * splitting on whitespace second leaves the comma glued to the surname
 * ("Doe, Jane" → "doe,"), which then fails to equal "doe" from "Jane Doe" and
 * silently scores a genuinely matching pair 0 (found by measurement, not
 * theorized). `references.ts`'s BibTeX/RIS parsing already normalizes to
 * "First Last" (`normalizeAuthorName`), so this mostly matters for CSL-JSON
 * and hand-edited author fields — but it costs nothing to handle either way.
 */
function surnameOf(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return ''
  const comma = trimmed.indexOf(',')
  const head = comma === -1 ? trimmed : trimmed.slice(0, comma)
  const folded = foldDiacritics(head)
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // "Last, First": the head *is* the surname already (which may itself be
  // several words — "van der Berg, Jan"). No comma: the surname is assumed to
  // be the final token of a "First [Middle] Last" name.
  if (comma !== -1) return folded
  const tokens = folded.split(' ').filter(Boolean)
  return tokens.length > 0 ? tokens[tokens.length - 1] : ''
}

/** The Dice coefficient over two sets of tokens (title words, or author
 *  surnames — the same measure, reused rather than written twice). */
function diceOfSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return (2 * shared) / (a.size + b.size)
}

// ---------------------------------------------------------------------------
// Cost guards
//
// Detection is O(existing × incoming): a realistic 2000-paper project against
// a 1000-entry `.bib` file is 2,000,000 title pairs, run synchronously inside
// the store's `set`. Calling `stringSimilarity` (which computes a full
// Levenshtein matrix) on every pair measures at over 40 seconds of hard UI
// freeze — a shipped non-feature. The guards below bring the same, *provably
// identical* result down to well under a second, by proving most pairs cannot
// reach the threshold before ever computing an edit distance.
//
// Two independent, sound upper bounds on Levenshtein's ratio:
//  - length:    lev(a,b) >= |len(a) - len(b)|
//  - histogram: lev(a,b) >= (sum of |countA(c) - countB(c)| over every
//               character c) / 2 — each single edit (insert/delete/substitute)
//               can reduce that sum by at most 2, so no sequence of edits
//               shorter than half the sum can equalize the two histograms.
// Either bound alone is enough to prove `levenshteinRatio` cannot reach the
// threshold; neither can ever wrongly rule a genuine match out, because both
// are lower bounds on the true edit distance, hence upper bounds on the ratio.
// ---------------------------------------------------------------------------

/** Mirrors `similarity.ts`'s own `LEV_MAX_LEN`: past this length,
 *  `stringSimilarity` itself never computes Levenshtein, so neither does this —
 *  matching its behaviour exactly rather than approximating it. */
const LEV_MAX_LEN = 256

interface Prepared {
  /** Kept only to hand to the real `stringSimilarity` once the bounds below
   *  fail to rule a pair out — see `fuzzyScoreAtLeast`. */
  raw: string
  len: number
  tokens: Set<string>
  hist: Map<string, number>
}

function prepare(raw: string): Prepared {
  const norm = normalizeText(raw)
  const tokens = new Set(norm.split(' ').filter(Boolean))
  const hist = new Map<string, number>()
  for (const ch of norm) hist.set(ch, (hist.get(ch) ?? 0) + 1)
  return { raw, len: norm.length, tokens, hist }
}

function halfSumAbsDiff(a: Map<string, number>, b: Map<string, number>): number {
  let sum = 0
  for (const [ch, n] of a) sum += Math.abs(n - (b.get(ch) ?? 0))
  for (const [ch, n] of b) if (!a.has(ch)) sum += n
  return sum / 2
}

/**
 * `stringSimilarity`'s score, but only computed (and only ever returned) when
 * it is at least `threshold` — otherwise `null`, having proved that cheaply.
 *
 * The ordering is load-bearing, cheapest first: token Dice can pass where the
 * length bound would have skipped (short titles, heavily reordered/padded),
 * so it must run *before* any skip, not after. Whenever Dice alone already
 * clears the bar, the reported score is Dice itself rather than the (possibly
 * higher) true `stringSimilarity` — the whole point of this function is
 * avoiding a Levenshtein computation once the verdict is already decided; a
 * slightly conservative score for that one case costs nothing, since only the
 * >= threshold verdict, not the exact number, decides `certain`/`probable`/`new`.
 *
 * When neither cheap bound rules a pair out, this calls the real, shared
 * `stringSimilarity` for the exact answer rather than recomputing its formula
 * here from `levenshtein` directly — one implementation of "how alike are
 * these two strings", never two that can silently drift apart.
 */
function fuzzyScoreAtLeast(a: Prepared, b: Prepared, threshold: number): number | null {
  const dice = diceOfSets(a.tokens, b.tokens)
  if (dice >= threshold) return dice
  const maxLen = Math.max(a.len, b.len)
  if (maxLen === 0) return null
  if (a.len > LEV_MAX_LEN || b.len > LEV_MAX_LEN) return null

  const byLength = 1 - Math.abs(a.len - b.len) / maxLen
  if (byLength < threshold) return null
  const byHistogram = 1 - halfSumAbsDiff(a.hist, b.hist) / maxLen
  if (byHistogram < threshold) return null

  const score = stringSimilarity(a.raw, b.raw)
  return score >= threshold ? score : null
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface PreparedRecord {
  doi: string
  exactTitle: string
  full: Prepared
  /** The title up to (not including) its first colon, prepared the same way as
   *  `full` — or `full` itself again when there is no colon, so a title with
   *  no subtitle of its own still compares correctly against one that has a
   *  subtitle on the *other* side ("Deep Learning" vs "Deep Learning: A
   *  Review" — the first has nothing to strip, so its own full title stands
   *  in for its base title). */
  base: Prepared
  /** Surnames only, already folded and deduped — computed once per record
   *  rather than once per pair, same reasoning as `full`/`base` above. */
  authorSurnames: Set<string>
  year?: number
}

function prepareRecord(rec: DupRecord): PreparedRecord {
  const colon = rec.title.indexOf(':')
  return {
    doi: normalizeDoi(rec.doi),
    exactTitle: normalizeTitleForMatch(rec.title),
    full: prepare(rec.title),
    base: prepare(colon === -1 ? rec.title : rec.title.slice(0, colon)),
    authorSurnames: new Set(rec.authors.map(surnameOf).filter(Boolean)),
    year: rec.year,
  }
}

interface PairMatch {
  kind: 'certain' | 'probable'
  reason: DupReason
}

/**
 * How alike one candidate pair is, evaluated in a fixed priority order — DOI,
 * then exact title, then fuzzy title, then base-title-plus-authors — each
 * strictly stronger evidence than the next, so the first rule that fires wins.
 *
 * Exact-normalized-title stays `certain` (silent) whenever nothing actively
 * contradicts it, by design: demoting every exact-title match to a prompt
 * would ask the reviewer to confirm *every paper* on a routine re-import of
 * the same `.bib` to refresh it. Only the two cases with actual contradicting
 * evidence — two different known DOIs, or a large year gap — demote it.
 */
function classifyPair(a: PreparedRecord, b: PreparedRecord): PairMatch | null {
  if (a.doi && b.doi && a.doi === b.doi) return { kind: 'certain', reason: { via: 'doi' } }

  if (!a.exactTitle || !b.exactTitle) return null

  const doiConflict = a.doi !== '' && b.doi !== '' && a.doi !== b.doi
  const yearVeto = a.year != null && b.year != null && Math.abs(a.year - b.year) >= YEAR_GAP_VETO

  if (a.exactTitle === b.exactTitle) {
    if (yearVeto) return null
    if (doiConflict) return { kind: 'probable', reason: { via: 'title', score: 1 } }
    // Identical titles and *not one author in common* is not a duplicate we
    // should merge without asking. Titles like "Introduction", "Editorial" or
    // "Discussion" are shared by unrelated papers all over a proceedings-heavy
    // corpus, and `certain` merges silently: `fillFromRef` then writes one
    // paper's DOI, year and venue onto the other, which is a wrong record
    // rather than a missing one.
    //
    // Complete disjointness only, not the similarity threshold used below. A
    // shortened author list ("et al.") or initials-vs-full-names still shares a
    // surname and stays `certain`, so ordinary matches are unaffected — and an
    // empty author list on either side abstains rather than voting against,
    // the same rule as the base-title tier.
    const bothHaveAuthors = a.authorSurnames.size > 0 && b.authorSurnames.size > 0
    if (bothHaveAuthors && diceOfSets(a.authorSurnames, b.authorSurnames) === 0) {
      return { kind: 'probable', reason: { via: 'title', score: 1 } }
    }
    return { kind: 'certain', reason: { via: 'title', score: 1 } }
  }

  const fullScore = fuzzyScoreAtLeast(a.full, b.full, TITLE_SIM_THRESHOLD)
  if (fullScore !== null) {
    if (yearVeto) return null
    return { kind: 'probable', reason: { via: 'title', score: fullScore } }
  }

  const baseScore = fuzzyScoreAtLeast(a.base, b.base, TITLE_SIM_THRESHOLD)
  if (baseScore !== null && a.authorSurnames.size > 0 && b.authorSurnames.size > 0) {
    // Neither side blank: an author field abstains rather than voting
    // against, same rule as `similarity.ts`'s `Sim`/`NO_EVIDENCE` — a base-title
    // match with no author evidence on one side stays `new`, not `probable`.
    const authScore = diceOfSets(a.authorSurnames, b.authorSurnames)
    if (authScore >= AUTHOR_SIM_THRESHOLD) {
      if (yearVeto) return null
      return { kind: 'probable', reason: { via: 'base-title', score: baseScore, authors: authScore } }
    }
  }

  return null
}

/** How much a match is worth, for picking the best candidate: a DOI-certain
 *  match beats a title-certain match beats any probable match, and probable
 *  matches are ranked by score — all comfortably below the certain tiers,
 *  since every `Sim` score here is 0..1. */
function rank(m: PairMatch): number {
  if (m.kind === 'certain') return m.reason.via === 'doi' ? 1000 : 999
  return (m.reason as { score: number }).score
}

/**
 * One verdict per incoming record, index-aligned with `incoming`.
 *
 * Each entry is compared against every `existing` record *and* every earlier
 * entry in `incoming` — one `.bib` can list the same paper twice. This is why
 * a `{ where: 'batch', index }` target is always lower than the entry's own
 * index: entry N only ever sees entries 0..N-1, never a later one. That
 * ordering is load-bearing for the caller — see `editorStore.ts`'s
 * `commitImport`, which resolves a batch target's *actual* landing spot by
 * walking entries in the same index order and is guaranteed the target
 * already has one by the time it gets there.
 */
export function classifyImport(existing: DupRecord[], incoming: DupRecord[]): DupVerdict[] {
  const existingPrepared = existing.map(prepareRecord)
  const batchPrepared: PreparedRecord[] = []
  const verdicts: DupVerdict[] = []

  for (let i = 0; i < incoming.length; i++) {
    const prep = prepareRecord(incoming[i])
    let best: (PairMatch & { target: DupTarget }) | null = null

    for (let j = 0; j < existingPrepared.length; j++) {
      const m = classifyPair(prep, existingPrepared[j])
      if (m && (!best || rank(m) > rank(best))) best = { ...m, target: { where: 'existing', index: j } }
      if (best && best.kind === 'certain' && best.reason.via === 'doi') break // nothing beats it
    }
    if (!(best && best.kind === 'certain' && best.reason.via === 'doi')) {
      for (let j = 0; j < batchPrepared.length; j++) {
        const m = classifyPair(prep, batchPrepared[j])
        if (m && (!best || rank(m) > rank(best))) best = { ...m, target: { where: 'batch', index: j } }
        if (best && best.kind === 'certain' && best.reason.via === 'doi') break
      }
    }

    verdicts.push(best ? { kind: best.kind, target: best.target, reason: best.reason } : { kind: 'new' })
    batchPrepared.push(prep)
  }

  return verdicts
}
