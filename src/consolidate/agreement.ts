import type { Project } from '../model/project'
import type { MetricInput, Ratings } from './metrics'
import { projectVerdicts } from './disagreements'

/**
 * Reduces a project down to the opaque `raters`/`units` shape `metrics.ts`
 * consumes. `metrics.ts` deliberately knows nothing about papers, schemas or
 * reviewers; this is the one place that bridges the two, so a coefficient's
 * arithmetic never has to change when the annotation tree's shape does.
 */
export interface AgreementInput {
  input: MetricInput
  /** Fields at least two reviewers answered — the units the statistics use. */
  unitCount: number
  /** Fields skipped because fewer than two reviewers answered them. */
  skipped: number
}

/**
 * Turn a project's per-field verdicts into the input every agreement
 * coefficient shares.
 *
 * A verdict becomes a unit only when `answeredBy.length >= 2`. This is not a
 * convenience filter — `disagreements.ts` says outright that a field fewer
 * than two reviewers answered "carries no agreement information at all", and
 * that a caller computing a statistic must gate on that count rather than
 * trust `agree` (which reads `true` for zero or one answers, vacuously, not
 * because anyone agreed on anything). Feeding such a field in regardless
 * would let one reviewer's silence read as "everyone agreed", or let a lone
 * opinion sit in a coefficient's denominator as if it had ever been compared
 * against another. All three coefficients in `metrics.ts` are defined in
 * terms of what raters *disagree* on; a unit only one rater touched has no
 * such thing to offer. This is also not a project-specific choice: excluding
 * units rated by fewer than two raters is the standard convention behind
 * Cohen's, Fleiss', and Krippendorff's alike, in every canonical
 * formulation — the gate belongs here, once, rather than being re-derived (or
 * forgotten) by every caller.
 */
export function agreementInput(project: Project): AgreementInput {
  const raters = Array.from({ length: project.reviewers }, (_, i) => String(i + 1))
  const units: Ratings[] = []
  let skipped = 0

  for (const verdict of projectVerdicts(project)) {
    if (verdict.answeredBy.length < 2) {
      skipped++
      continue
    }
    const ratings: Ratings = {}
    for (const r of raters) ratings[r] = verdict.answeredBy.includes(r) ? verdict.categories[r] : null
    units.push(ratings)
  }

  return { input: { raters, units }, unitCount: units.length, skipped }
}
