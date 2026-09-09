import { normalizeText, stringSimilarity } from '../consolidate/similarity'

/**
 * Flags probable duplicate papers at import time, reusing `consolidate/similarity`'s
 * lexical matcher (same known ceiling: "RCT" vs "randomised controlled trial" scores low).
 *
 * Pure and store-free: knows nothing of `EditorPaper`/DOM/React. `editorStore.ts`
 * adapts its own shapes into `DupRecord` and turns a `DupVerdict` into a mutation.
 */

/** Minimal bibliographic shape this module reasons about — deliberately not
 *  `EditorPaper` or `RefEntry`, which it must not know exist. */
export interface DupRecord {
  title: string
  authors: string[]
  doi?: string
  /** Often absent in real records; never blocks a match (see `YEAR_GAP_VETO`),
   *  just can't corroborate or veto one either. */
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

/** Lowercased, whitespace-collapsed, all punctuation stripped — so titles differing
 *  only in casing/spacing/punctuation (em-dash vs hyphen, colon vs none) collapse
 *  to the same string and reach the exact/certain path rather than the fuzzy one. */
export function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lowercased/trimmed with a leading `https://doi.org/`, `http://dx.doi.org/`, or
 *  `doi:` stripped — CSL-JSON often carries the URL form, which would otherwise
 *  miss a match against a bare DOI. */
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
 * Similarity (`stringSimilarity`) two whole titles (or subtitle-stripped base
 * titles) must reach to count as a probable duplicate.
 *
 * Measured against real pairs (see `duplicates.test.ts`), no single threshold
 * cleanly separates different-paper from same-paper pairs. 0.90 sits above every
 * measured different-paper pair except "...Part I" vs "...Part II" (0.978,
 * accepted as a known false positive — one extra review-dialog click), and below
 * every same-paper pair whose whole title differs. Lowering it would also catch
 * "for Java"/"for Python"-style false positives, trading one rare miss for
 * several common ones.
 */
const TITLE_SIM_THRESHOLD = 0.9

/**
 * Author-surname Dice score needed to corroborate a base-title match (see
 * `classifyPair`). Base-title equality alone isn't enough — "...: A Survey" vs
 * "...: An Introduction" share one but are different papers.
 *
 * 0.50 is deliberate: a truncated ("et al.") 1-author list sharing one name with
 * a real 3-author list scores exactly 0.50 and must still count, while two
 * genuinely mostly-different 3-author lists sharing one name score 0.33.
 */
const AUTHOR_SIM_THRESHOLD = 0.5

/**
 * Year gap this large on an otherwise title-matching pair means "different
 * artifact" (e.g. workshop paper vs. its journal extension), downgrading a would-be
 * match all the way to `new`. Not `!==`: databases routinely disagree by one year
 * (online-first vs. issue date). Never applied to a DOI match — same DOI is the
 * same record regardless of year.
 */
const YEAR_GAP_VETO = 2

// ---------------------------------------------------------------------------
// Author surnames
// ---------------------------------------------------------------------------

/** Diacritic-fold so "José" and "Jose" land on the same surname. */
function foldDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * Surname of one author's recorded name, folded for comparison.
 *
 * Must split on the comma before stripping punctuation, or "Doe, Jane" leaves a
 * comma glued to the surname ("doe,") and fails to match "doe" from "Jane Doe".
 * `references.ts` already normalizes BibTeX/RIS to "First Last", so this mainly
 * matters for CSL-JSON and hand-edited fields.
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
  // "Last, First": head is already the surname (may be multi-word). No comma:
  // assume surname is the final token of "First [Middle] Last".
  if (comma !== -1) return folded
  const tokens = folded.split(' ').filter(Boolean)
  return tokens.length > 0 ? tokens[tokens.length - 1] : ''
}

/** Dice coefficient over two sets of tokens (title words or author surnames). */
function diceOfSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return (2 * shared) / (a.size + b.size)
}

// ---------------------------------------------------------------------------
// Cost guards
//
// Detection is O(existing x incoming): 2000 papers against a 1000-entry .bib
// is 2M pairs, run synchronously — full Levenshtein on every pair measures
// over 40s of UI freeze. The guards below prove most pairs can't reach the
// threshold before computing an edit distance, giving an identical result
// well under a second.
//
// Two sound lower bounds on Levenshtein distance (hence upper bounds on the
// similarity ratio), either sufficient to rule a pair out without ever
// wrongly ruling a genuine match out:
//  - length:    lev(a,b) >= |len(a) - len(b)|
//  - histogram: lev(a,b) >= (sum of |countA(c) - countB(c)| over every char) / 2
//               (each edit changes that sum by at most 2)
// ---------------------------------------------------------------------------

/** Mirrors `similarity.ts`'s own `LEV_MAX_LEN`: past this length,
 *  `stringSimilarity` never computes Levenshtein either, so this matches. */
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
 * `stringSimilarity`'s score, but only computed (and only returned) when it's
 * at least `threshold` — otherwise `null`.
 *
 * Order is load-bearing, cheapest first: token Dice can pass where the length
 * bound would skip (short/reordered/padded titles), so it must run before any
 * skip. When Dice alone clears the bar, the returned score is Dice itself (not
 * the possibly-higher true similarity) — good enough since only the >=threshold
 * verdict, not the exact number, matters downstream.
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
  /** Title up to its first colon (or the whole title if none), so "Deep
   *  Learning" still compares correctly against "Deep Learning: A Review". */
  base: Prepared
  /** Folded, deduped surnames — computed once per record, not once per pair. */
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
 * Evaluated in fixed priority order — DOI, exact title, fuzzy title,
 * base-title-plus-authors — each strictly stronger evidence than the next.
 *
 * Exact-title matches stay `certain` (silent) unless something actively
 * contradicts them (conflicting DOI or a large year gap) — otherwise a routine
 * re-import of the same `.bib` would prompt the reviewer on every paper.
 */
function classifyPair(a: PreparedRecord, b: PreparedRecord): PairMatch | null {
  if (a.doi && b.doi && a.doi === b.doi) return { kind: 'certain', reason: { via: 'doi' } }

  if (!a.exactTitle || !b.exactTitle) return null

  const doiConflict = a.doi !== '' && b.doi !== '' && a.doi !== b.doi
  const yearVeto = a.year != null && b.year != null && Math.abs(a.year - b.year) >= YEAR_GAP_VETO

  if (a.exactTitle === b.exactTitle) {
    if (yearVeto) return null
    if (doiConflict) return { kind: 'probable', reason: { via: 'title', score: 1 } }
    // Identical title but zero shared authors shouldn't silently merge: generic
    // titles ("Introduction", "Editorial") recur across unrelated papers in a
    // proceedings-heavy corpus, and `certain` would let `fillFromRef` overwrite
    // one paper's DOI/year/venue with another's. Requires complete disjointness
    // (not the fuzzy threshold), so "et al." truncation still stays `certain`;
    // an empty author list on either side abstains rather than voting against.
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
    // Neither side blank: same NO_EVIDENCE rule as similarity.ts — a base-title
    // match with no author evidence on one side stays `new`, not `probable`.
    const authScore = diceOfSets(a.authorSurnames, b.authorSurnames)
    if (authScore >= AUTHOR_SIM_THRESHOLD) {
      if (yearVeto) return null
      return { kind: 'probable', reason: { via: 'base-title', score: baseScore, authors: authScore } }
    }
  }

  return null
}

/** Ranks candidates: DOI-certain > title-certain > probable-by-score (all
 *  scores are 0..1, comfortably below the certain tiers). */
function rank(m: PairMatch): number {
  if (m.kind === 'certain') return m.reason.via === 'doi' ? 1000 : 999
  return (m.reason as { score: number }).score
}

/**
 * One verdict per incoming record, index-aligned with `incoming`.
 *
 * Each entry is compared against every `existing` record and every earlier
 * `incoming` entry (one `.bib` can list the same paper twice) — so a
 * `{ where: 'batch', index }` target is always lower than the entry's own
 * index. `editorStore.ts`'s `commitImport` relies on this ordering to resolve
 * a batch target's landing spot by walking entries in the same order.
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
