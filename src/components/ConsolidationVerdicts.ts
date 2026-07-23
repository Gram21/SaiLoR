import { createContext, useContext } from 'react'

export type ConsolidationFieldStatus = 'agree' | 'disagree'

const emptyVerdicts = new Map<string, ConsolidationFieldStatus>()

/**
 * Visual status for one field in Consolidation. Green means every configured
 * reviewer answered and they all agree. Red surfaces any disagreement already
 * present among the answers, even while another reviewer is still pending.
 */
export function consolidationFieldStatus(
  answeredCount: number,
  reviewerCount: number,
  agree: boolean,
): ConsolidationFieldStatus | undefined {
  if (answeredCount === reviewerCount && agree) return 'agree'
  if (answeredCount >= 2 && !agree) return 'disagree'
  return undefined
}

/** The current paper's reviewer verdicts, computed once by `AnnotationPanel`. */
export const ConsolidationVerdictsContext = createContext<ReadonlyMap<string, ConsolidationFieldStatus>>(
  emptyVerdicts,
)

export function useConsolidationFieldStatus(canonical: string): ConsolidationFieldStatus | undefined {
  return useContext(ConsolidationVerdictsContext).get(canonical)
}