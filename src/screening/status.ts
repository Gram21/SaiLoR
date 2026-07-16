import type { AnnotationValueTree } from '../model/annotations'
import { DECISION_EXCLUDE, DECISION_INCLUDE, SCREENING_DECISION, SCREENING_REASON } from './schema'

export type ScreeningStatus = 'included' | 'excluded' | 'undecided'

/**
 * One tree's decision. `undefined`/null tree, a missing node, or anything that
 * is not one of the two options reads as `undecided` — the file is
 * hand-editable, and an unrecognised decision is not a decision. This is the
 * conservative direction: a status this function cannot make sense of is
 * "not screened", never "excluded" — see `importFromScreening`, which relies
 * on that to never silently drop a paper it merely couldn't parse.
 */
export function screeningStatus(tree: AnnotationValueTree | null | undefined): ScreeningStatus {
  const value = tree?.[SCREENING_DECISION]?.[0]?.value
  if (value === DECISION_INCLUDE) return 'included'
  if (value === DECISION_EXCLUDE) return 'excluded'
  return 'undecided'
}

/**
 * The exclusion reason recorded on a tree, or null. Only meaningful when the
 * status is `excluded`; callers must check — a stray `Reason` on an included
 * or undecided paper (a hand-edited file, or a decision walked back without
 * clearing it) is not this function's business to interpret.
 */
export function screeningReason(tree: AnnotationValueTree | null | undefined): string | null {
  const value = tree?.[SCREENING_REASON]?.[0]?.value
  return typeof value === 'string' && value !== '' ? value : null
}
