import { isField, type ResolvedDef } from '../model/schema'
import { hasAnnotations, normalizeTree, type AnnotationValueTree, type FieldValue } from '../model/annotations'
import { alignedReviews, type StoredAlignment } from '../model/alignment'
import type { Paper, Project } from '../model/project'
import { isUnanswered } from '../llm/fields'
import { formatPath } from '../llm/paths'
import { comparable } from './unanimous'
import type { PathSeg } from '../state/store'

/**
 * Turns reviewers' trees into per-field verdicts for agreement stats and
 * disagreement views. Pure/read-only — reconciling still happens by hand in
 * Consolidation mode.
 */

/** What the reviewers said about one field of one paper, and whether they agree. */
export interface FieldVerdict {
  paperId: string
  paperTitle: string
  /** Canonical path, e.g. "Findings[1]/Claim". */
  canonical: string
  path: PathSeg[]
  name: string
  index: number
  def: ResolvedDef
  /** reviewer id -> their raw value (absent/undefined = did not answer). */
  values: Record<string, FieldValue | undefined>
  /** Reviewers who actually answered, per `isUnanswered`. */
  answeredBy: string[]
  /** The consolidator declared these equivalent. */
  markedEqual: boolean
  /** True when every answering reviewer gave the same category. */
  agree: boolean
  /**
   * True if one reviewer recorded this repeated entry and another did not.
   * Kept separate from `agree` because a unit only one rater touched carries
   * no agreement information (see `agreement.ts`'s `answeredBy.length >= 2`
   * gate) — folding it in would corrupt every κ. Only meaningful with 2+
   * participants; otherwise every entry is trivially one-sided.
   */
  oneSided: boolean
  /**
   * Reviewers who annotated anything on this paper — not `project.reviewers`,
   * since a reviewer who hasn't opened the paper isn't withholding an answer.
   */
  participantCount: number
  /**
   * The category each answering reviewer's value falls in — the input an
   * agreement statistic consumes. Normalised text, or one shared synthetic
   * category when `markedEqual`.
   */
  categories: Record<string, string>
}

/**
 * Shared category for fields the consolidator marked equivalent. Starts with
 * whitespace so it can never collide with a real category (`comparable` always
 * trims its output).
 */
const MARKED_EQUAL_CATEGORY = ' marked-equal'

/** Every comparable field of one paper, in schema order. */
export function paperVerdicts(schema: ResolvedDef[], paper: Paper, reviewerCount: number): FieldVerdict[] {
  const reviewerIds = Array.from({ length: reviewerCount }, (_, i) => String(i + 1))
  const stored: Record<string, AnnotationValueTree | undefined> = {}
  for (const r of reviewerIds) stored[r] = paper.reviews[r]
  // Reindexes via the recorded matching so `walk`'s fixed-index reads mean
  // "the same entry" across reviewers; identity if `paper.alignment` is empty.
  const reviews = alignedReviews(schema, paper.alignment, stored)

  // NOTE (known limitation): `paper.alignment` is recorded lazily by
  // Consolidation, one paper at a time. On a paper nobody has consolidated
  // yet, the Agreement/Disagreements views (which run over the whole project)
  // compare mismatched entries — reordered findings can read as total
  // disagreement and Cohen's κ can hit −1. `needsAlignment` (readiness.ts)
  // warns about this. Computing a fresh alignment here was tried and reverted:
  // it produces `canonical`/`index` values the consolidated tree (which
  // `paper.equal` and click-to-jump resolve against) was never grown against.
  // Proper fix: record the matching for every paper, not just the opened one.

  // Per-paper (not per-field) annotation presence, matching
  // `readyToConsolidate`'s rule — needed so a bare `false` on an unopened
  // paper isn't counted as an answer. `hasAnnotations` assumes a normalized
  // tree, so route through `normalizeTree` first.
  const touchedBy: Record<string, boolean> = {}
  for (const r of reviewerIds) touchedBy[r] = hasAnnotations(schema, normalizeTree(schema, reviews[r]))

  // `oneSided` compares against these, not all configured reviewers, so an
  // unopened paper doesn't read as "disagreement" with the absent reviewer.
  const participants = reviewerIds.filter((r) => touchedBy[r])

  const out: FieldVerdict[] = []
  walk(schema, reviews, reviewerIds, [], paper, out, touchedBy, paper.alignment, participants, false)
  return out
}

/** Every comparable field of every paper. */
export function projectVerdicts(project: Project): FieldVerdict[] {
  return project.papers.flatMap((p) => paperVerdicts(project.schema, p, project.reviewers))
}

function walk(
  defs: ResolvedDef[],
  reviews: Record<string, AnnotationValueTree | undefined>,
  reviewerIds: string[],
  prefix: PathSeg[],
  paper: Paper,
  out: FieldVerdict[],
  touchedBy: Record<string, boolean>,
  alignment: StoredAlignment,
  participants: string[],
  /** True if an ancestor entry was one-sided — propagates down since a field
   *  of a finding only one reviewer recorded is one-sided too. */
  parentOneSided: boolean,
): void {
  for (const def of defs) {
    // Post-alignment, index N is the same entry for every reviewer, so walk as
    // many indices as the most prolific reviewer recorded; floor of 1 so an
    // untouched field still gets an (all-unanswered) verdict.
    const counts = reviewerIds.map((r) => {
      const raw = reviews[r]?.[def.name]
      return Array.isArray(raw) ? raw.length : 0
    })
    const instanceCount = Math.max(1, ...counts)

    const slots = alignment[def.name]

    for (let index = 0; index < instanceCount; index++) {
      const segs = [...prefix, { name: def.name, index }]
      const canonical = formatPath(segs)

      // An entry some participants contributed to and others did not.
      const slot = slots?.[index]
      const oneSided =
        parentOneSided ||
        (participants.length >= 2 && !!slot && participants.some((r) => slot.members[r] === undefined))

      if (isField(def)) {
        const values: Record<string, FieldValue | undefined> = {}
        for (const r of reviewerIds) values[r] = reviews[r]?.[def.name]?.[index]?.value

        // `false` is a real answer on a paper the reviewer has worked, but
        // `normalizeReviews` also writes `false` skeletons for unopened
        // papers — so gate on `touchedBy` (paper-level, not per-field).
        const answeredBy = reviewerIds.filter((r) =>
          def.type === 'boolean'
            ? touchedBy[r] && values[r] !== undefined && values[r] !== null
            : !isUnanswered(def, values[r]),
        )
        const markedEqual = paper.equal.includes(canonical)

        const categories: Record<string, string> = {}
        for (const r of answeredBy) categories[r] = markedEqual ? MARKED_EQUAL_CATEGORY : comparable(values[r])

        // Fewer than 2 answers carries no agreement info; `agree` defaults
        // `true` here, so statistic callers must gate on
        // `answeredBy.length >= 2` rather than trust `agree` alone.
        const agree = new Set(answeredBy.map((r) => categories[r])).size <= 1

        out.push({
          paperId: paper.id,
          paperTitle: paper.title,
          canonical,
          path: prefix,
          name: def.name,
          index,
          def,
          values,
          answeredBy,
          markedEqual,
          agree,
          oneSided,
          participantCount: participants.length,
          categories,
        })
      }

      if (def.children.length > 0) {
        const childReviews: Record<string, AnnotationValueTree | undefined> = {}
        for (const r of reviewerIds) childReviews[r] = reviews[r]?.[def.name]?.[index]?.children
        walk(
          def.children,
          childReviews,
          reviewerIds,
          segs,
          paper,
          out,
          touchedBy,
          slot?.children ?? {},
          participants,
          oneSided,
        )
      }
    }
  }
}

/** Human-readable, type-aware rendering of one reviewer's raw value; shared by
 *  `DisagreementOverview`, `ConsolidationDialog`'s compare popup, and export. */
export function formatValue(def: ResolvedDef, value: FieldValue | undefined): string {
  if (value === undefined || value === null) return '— left empty —'
  if (def.type === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' && value.trim() === '') return '— left empty —'
  return String(value)
}
