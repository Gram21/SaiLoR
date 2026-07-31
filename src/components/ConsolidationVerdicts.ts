import { createContext, useContext } from 'react'

export type ConsolidationFieldStatus = 'agree' | 'disagree'

const emptyVerdicts = new Map<string, ConsolidationFieldStatus>()

/**
 * Visual status for one field in Consolidation. Green means every configured
 * reviewer answered and they all agree. Red surfaces any disagreement already
 * present among the answers, even while another reviewer is still pending.
 *
 * `oneSided` is the third case, and it needs its own argument rather than
 * folding into `agree`: the field sits in a repeated entry only some reviewers
 * recorded at all. Two answers cannot disagree there because there is only
 * one, so the `answeredCount >= 2` rule below would leave it uncoloured —
 * indistinguishable from a field nobody has reached, when in fact it is
 * precisely what the consolidator has to rule on (keep this finding, or drop
 * it). It stays out of `agree` because that feeds the κ statistics, where a
 * unit only one rater touched must not count either way.
 */
export function consolidationFieldStatus(
  answeredCount: number,
  reviewerCount: number,
  agree: boolean,
  oneSided = false,
  participantCount = reviewerCount,
): ConsolidationFieldStatus | undefined {
  // Checked before agreement, not after: nothing inside an entry only some
  // reviewers recorded can be agreement, whatever the values look like. A
  // Yes/No left unticked in a finding the other reviewer never wrote down
  // reads as a shared `false` — two reviewers "agreeing" about a finding only
  // one of them has. An empty row is still just an empty row, though.
  if (oneSided) return answeredCount >= 1 ? 'disagree' : undefined

  if (answeredCount === reviewerCount && agree) return 'agree'
  if (answeredCount >= 2 && !agree) return 'disagree'
  // Some participants answered and others left it blank. Silence against a
  // recorded value is a difference the consolidator still has to settle —
  // take the value, or accept the blank — even though it is not two answers
  // in conflict and so never reaches the rule above.
  if (answeredCount >= 1 && answeredCount < participantCount) return 'disagree'
  return undefined
}

/** The current paper's reviewer verdicts, computed once by `AnnotationPanel`. */
export const ConsolidationVerdictsContext = createContext<ReadonlyMap<string, ConsolidationFieldStatus>>(
  emptyVerdicts,
)

export function useConsolidationFieldStatus(canonical: string): ConsolidationFieldStatus | undefined {
  return useContext(ConsolidationVerdictsContext).get(canonical)
}