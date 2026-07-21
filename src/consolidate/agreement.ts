import type { Project } from '../model/project'
import type { MetricInput, Ratings } from './metrics'
import { projectVerdicts } from './disagreements'
import { SCREENING_DECISION } from '../screening/schema'

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
  /** Boolean fields left out of the statistic entirely — see `agreementInput`. */
  booleansExcluded: number
  /**
   * The same units, broken out per schema field, in schema order — see
   * `AgreementDialog.tsx`. One coefficient pooled over every field mixes
   * categories that were never comparable: a `Year` and a free-text `Claim`
   * do not share a category space, and pooling them into one number hides
   * that. A repeated field's instances (every paper's every `Findings ›
   * Claim`) are pooled together here — they *are* the same field — but kept
   * apart from every other field.
   */
  perField: FieldAgreement[]
}

/** One schema field's own slice of the agreement input. */
export interface FieldAgreement {
  /** Groups instances of the same field across papers — ancestor node names
   *  joined with "/", no instance indices (those are pooled, not part of
   *  the field's identity). */
  key: string
  /** For display: the same path, "Findings › Claim" style. */
  label: string
  input: MetricInput
  unitCount: number
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
  let booleansExcluded = 0
  // Insertion order = schema order, since `projectVerdicts` walks each
  // paper's schema top to bottom and every paper shares the same schema —
  // the first paper to reach a field fixes that field's position here.
  const perFieldUnits = new Map<string, { label: string; units: Ratings[] }>()

  // A screening phase reports agreement on the include/exclude decision. The
  // exclusion reason is a different question — and one only defined on the
  // papers both reviewers excluded — so folding it into the same coefficient
  // would produce a number that is neither. Filtered out entirely rather than
  // counted as "skipped", which means "too few reviewers answered" and would
  // be a lie here.
  const decisionOnly = project.screening !== null

  for (const verdict of projectVerdicts(project)) {
    if (decisionOnly && !(verdict.path.length === 0 && verdict.name === SCREENING_DECISION)) continue

    // Boolean fields are left out, and this is a correctness fix rather than a
    // simplification.
    //
    // Every untouched boolean reads `false`, so nothing distinguishes "looked
    // and said no" from "never looked" — which is why `isUnanswered` counts an
    // unticked box as unanswered, and why `similarity.ts` gives a `false` no
    // weight. The consequence here was that a boolean only ever reached the
    // `answeredBy.length >= 2` gate when *every* reviewer ticked it true: a
    // true/false split scored one answerer and was dropped, false/false scored
    // none. So the only boolean units that survived were guaranteed agreements,
    // and every real boolean disagreement was discarded — the coefficient came
    // out higher than the truth, which for a published statistic is the worst
    // direction to be wrong in. Measured on a small project: kappa 0.500 where
    // the honest value over the measurable fields was 0.000.
    //
    // Counting them out is the honest reading of what the data supports. The
    // count is reported separately so the dialog can say so rather than let the
    // reader assume every field was measured.
    if (verdict.def.type === 'boolean') {
      booleansExcluded++
      continue
    }

    if (verdict.answeredBy.length < 2) {
      skipped++
      continue
    }
    const ratings: Ratings = {}
    for (const r of raters) ratings[r] = verdict.answeredBy.includes(r) ? verdict.categories[r] : null
    units.push(ratings)

    const segNames = verdict.path.map((s) => s.name)
    const key = [...segNames, verdict.name].join('/')
    let bucket = perFieldUnits.get(key)
    if (!bucket) {
      bucket = { label: [...segNames, verdict.name].join(' › '), units: [] }
      perFieldUnits.set(key, bucket)
    }
    bucket.units.push(ratings)
  }

  const perField: FieldAgreement[] = [...perFieldUnits.entries()].map(([key, { label, units: u }]) => ({
    key,
    label,
    input: { raters, units: u },
    unitCount: u.length,
  }))

  return { input: { raters, units }, unitCount: units.length, skipped, booleansExcluded, perField }
}
