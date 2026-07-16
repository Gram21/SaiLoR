import type { AnnotationDef, ScreeningConfig } from '../model/schema'
import type { Project } from '../model/project'

/**
 * The fixed two-field schema every screening project has, derived from
 * `config.screening.reasons` rather than authored (see `Project.screening`).
 *
 * The user's original ask was "a boolean field for excluded". That is not what
 * this derives: `Decision` is a two-option enum (`Include`/`Exclude`), not a
 * checkbox. The reason is a hard constraint of this codebase, not a stylistic
 * choice — see `isEmptyValue` in `model/validate.ts` ("booleans are NEVER
 * empty"), `isUnanswered` in `llm/fields.ts`, and `hasAnnotations` in
 * `model/annotations.ts` (which only counts a boolean once it is `true`). An
 * "Exclude" checkbox cannot tell "I decided to include this" from "I have not
 * looked at this yet" — both would read as `false`. Screening is the one
 * phase where that distinction *is* the output: the progress count, the
 * PRISMA include/exclude/pending numbers, and — above all — which papers
 * survive into an import all depend on it. A checkbox would also break every
 * piece of machinery this feature exists to reuse: `hasAnnotations` would
 * call an included paper unannotated, `readyToConsolidate` would say a paper
 * both reviewers *included* is not ready to consolidate, `unanimousFills`
 * would refuse to adopt a unanimous "include", and kappa would only ever see the
 * excluded papers. A two-option enum gets the tri-state for free and every
 * one of those modules stays correct with no change at all.
 */
export const SCREENING_DECISION = 'Decision'
export const SCREENING_REASON = 'Reason'
export const DECISION_INCLUDE = 'Include'
export const DECISION_EXCLUDE = 'Exclude'

/**
 * Seeded into a new screening project. Ordinary SLR exclusion reasons; the
 * author edits them. "Other" is here on purpose — a closed enum needs an
 * authored escape hatch, not a magic one.
 */
export const DEFAULT_SCREENING_REASONS: string[] = [
  'Not peer-reviewed',
  'Wrong topic',
  'Wrong population',
  'Wrong study type',
  'Not in English',
  'Full text unavailable',
  'Duplicate',
  'Other',
]

/**
 * The schema every screening project has. `config.schema` is never read for a
 * screening project (see `loadProject`) — this is what is written there
 * instead, both in memory and back out on save, so the two can never drift.
 */
export function screeningSchemaDefs(config: ScreeningConfig): AnnotationDef[] {
  return [
    {
      name: SCREENING_DECISION,
      type: 'string',
      options: [DECISION_INCLUDE, DECISION_EXCLUDE],
      description: 'Include this paper in the review, or exclude it. Left unset until you decide.',
    },
    {
      name: SCREENING_REASON,
      type: 'string',
      options: [...config.reasons],
      description: 'Why this paper is excluded. Only applies when the decision is Exclude.',
    },
  ]
}

/** True when this project screens rather than annotates — the one predicate every caller uses. */
export function isScreening(project: Project | null | undefined): boolean {
  return !!project?.screening
}
