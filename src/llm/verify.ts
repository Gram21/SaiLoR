import type { ResolvedDef } from '../model/schema'
import type { LlmAnswer } from './types'
import { validateAnswerObject } from './parse'
import { resolvePath, MAX_UNBOUNDED_INDEX } from './paths'
import type { SubmitField, SubmitPayload } from './tools'

/**
 * The cheap checks that run before the judge ever sees a submission: does
 * each value type-check against the schema (reusing `parse.ts`'s validation),
 * and — for paper-sourced values — does the evidence quote actually appear in
 * the paper. Catching a hallucinated quote here costs nothing; catching it in
 * the judge costs an LLM call.
 */

export interface CheckFailure {
  path: string
  reason: string
}

/** One word- or NFKC-level normalization, so a quote copied verbatim from the
 *  paper still matches after PDF-extraction noise: curly quotes, ligatures, a
 *  word hyphenated across a line break, and incidental case/whitespace. */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    // pdfText's page separators must not break a quote that spans a page turn.
    .replace(/\[page \d+\]/gi, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    // A word split across a line break by a hyphen: "exam-\nple" -> "example".
    .replace(/(\w)-\s+(\w)/g, '$1$2')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Fraction of `words` found in `haystack`, in order, each within a lookahead
 *  window of the previous match — a simple stand-in for "this is basically the
 *  same passage" that tolerates a few extraction glitches without being a full
 *  fuzzy-matching library. */
const MATCH_WINDOW = 40

function wordMatchRatio(words: string[], haystack: string[]): number {
  if (words.length === 0) return 0
  let cursor = 0
  let matched = 0
  for (const w of words) {
    let found = -1
    for (let j = cursor; j < Math.min(haystack.length, cursor + MATCH_WINDOW); j++) {
      if (haystack[j] === w) {
        found = j
        break
      }
    }
    if (found !== -1) {
      matched++
      cursor = found + 1
    }
  }
  return matched / words.length
}

/** ≥85% of the quote's words found in order (within a small window), or an
 *  exact normalized substring match — documented, simple fuzzy-evidence check. */
export function evidenceSupported(evidence: string, paperText: string): boolean {
  const quote = evidence.trim()
  if (!quote) return false
  const normQuote = normalize(quote)
  if (!normQuote) return false
  const normText = normalize(paperText)
  if (normText.includes(normQuote)) return true
  return wordMatchRatio(normQuote.split(' '), normText.split(' ')) >= 0.85
}

function looksLikeUrl(s: string | undefined): s is string {
  return typeof s === 'string' && /^https?:\/\//i.test(s)
}

/**
 * Validate a submitted batch against the schema and, per field, against its
 * evidence. `fetchedUrls` is every URL the agent actually fetched this run —
 * a web-sourced value whose `source` isn't in that set failed to earn its keep.
 */
export function checkSubmission(
  schema: ResolvedDef[],
  payload: SubmitPayload,
  paperText: string,
  fetchedUrls: ReadonlySet<string>,
): { answer: LlmAnswer; failures: CheckFailure[] } {
  const root = {
    fields: payload.fields.map((f) => ({
      path: f.path,
      value: f.value,
      evidence: f.evidence,
      confidence: f.confidence,
    })),
    skipped: payload.skipped,
  }
  const answer = validateAnswerObject(schema, root)

  // `validateAnswerObject` doesn't know about `source` (agent-mode-only), so
  // re-resolve each submitted path to attach it to the matching accepted suggestion.
  const sourceByPath = new Map<string, string | undefined>()
  for (const f of payload.fields) {
    const resolved = resolvePath(schema, f.path, { maxUnboundedIndex: MAX_UNBOUNDED_INDEX })
    if (resolved) sourceByPath.set(resolved.canonical, f.source)
  }

  const failures: CheckFailure[] = []
  for (const suggestion of answer.fields) {
    const source = sourceByPath.get(suggestion.path)
    suggestion.source = source

    if (looksLikeUrl(source)) {
      if (!fetchedUrls.has(source)) {
        failures.push({
          path: suggestion.path,
          reason: `Source "${source}" was never fetched during this run.`,
        })
      }
      continue
    }

    // Paper-sourced (source is 'paper', absent, or anything else non-URL): the
    // quote must actually be in the paper.
    if (!evidenceSupported(suggestion.evidence, paperText)) {
      failures.push({
        path: suggestion.path,
        reason: 'Evidence quote could not be found in the paper text.',
      })
    }
  }

  return { answer, failures }
}

export type { SubmitField, SubmitPayload }
