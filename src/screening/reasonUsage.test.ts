import { describe, it, expect } from 'vitest'
import { countPapersUsingReason, renameReasonInPapers, type ReasonBearingPaper } from './reasonUsage'
import { SCREENING_DECISION, SCREENING_REASON, DECISION_EXCLUDE } from './schema'

/** A screening tree with a decision and (optionally) an exclusion reason —
 *  the exact shape a paper's `annotations`/`reviews[n]` hold. */
function tree(reason: string | null): Record<string, unknown> {
  return {
    [SCREENING_DECISION]: [{ value: DECISION_EXCLUDE }],
    ...(reason === null ? {} : { [SCREENING_REASON]: [{ value: reason }] }),
  }
}

function paper(reason: string | null, reviewerReasons?: Record<string, string | null>): ReasonBearingPaper {
  return {
    annotations: tree(reason),
    ...(reviewerReasons
      ? { extra: { reviews: Object.fromEntries(Object.entries(reviewerReasons).map(([k, r]) => [k, tree(r)])) } }
      : {}),
  }
}

describe('countPapersUsingReason', () => {
  it('counts papers whose consolidated tree records the reason', () => {
    const papers = [paper('Duplicate'), paper('Wrong topic'), paper('Duplicate'), paper(null)]
    expect(countPapersUsingReason(papers, 'Duplicate')).toBe(2)
    expect(countPapersUsingReason(papers, 'Wrong topic')).toBe(1)
    expect(countPapersUsingReason(papers, 'Never used')).toBe(0)
  })

  it('counts a reason held only in a reviewer tree, not the consolidated one', () => {
    const papers = [paper(null, { '1': 'Duplicate', '2': 'Wrong topic' })]
    expect(countPapersUsingReason(papers, 'Duplicate')).toBe(1)
    expect(countPapersUsingReason(papers, 'Wrong topic')).toBe(1)
  })

  it('counts a paper once even if several of its trees use the reason', () => {
    const papers = [paper('Duplicate', { '1': 'Duplicate', '2': 'Duplicate' })]
    expect(countPapersUsingReason(papers, 'Duplicate')).toBe(1)
  })

  it('never matches the empty reason — an unset reason uses nothing', () => {
    expect(countPapersUsingReason([paper(null)], '')).toBe(0)
  })

  it('tolerates papers with no annotations or a malformed tree', () => {
    const papers: ReasonBearingPaper[] = [{}, { annotations: null }, { annotations: 'nope' }, { annotations: [] }]
    expect(countPapersUsingReason(papers, 'Duplicate')).toBe(0)
  })
})

describe('renameReasonInPapers', () => {
  it('rewrites the reason in the consolidated tree', () => {
    const papers = [paper('Duplicate'), paper('Wrong topic')]
    const next = renameReasonInPapers(papers, 'Duplicate', 'Duplicate record')
    expect((next[0].annotations as Record<string, { value: string }[]>)[SCREENING_REASON][0].value).toBe(
      'Duplicate record',
    )
    // The paper that didn't use it keeps its identity untouched.
    expect(next[1]).toBe(papers[1])
  })

  it('rewrites the reason in reviewer trees too', () => {
    const papers = [paper(null, { '1': 'Duplicate', '2': 'Wrong topic' })]
    const next = renameReasonInPapers(papers, 'Duplicate', 'Duplicate record')
    const reviews = (next[0].extra as { reviews: Record<string, Record<string, { value: string }[]>> }).reviews
    expect(reviews['1'][SCREENING_REASON][0].value).toBe('Duplicate record')
    expect(reviews['2'][SCREENING_REASON][0].value).toBe('Wrong topic')
  })

  it('leaves the whole array identity-stable when nothing referenced the reason', () => {
    const papers = [paper('Wrong topic'), paper(null)]
    expect(renameReasonInPapers(papers, 'Duplicate', 'X')).toBe(papers)
  })

  it('is a no-op for an empty or unchanged rename', () => {
    const papers = [paper('Duplicate')]
    expect(renameReasonInPapers(papers, '', 'X')).toBe(papers)
    expect(renameReasonInPapers(papers, 'Duplicate', 'Duplicate')).toBe(papers)
  })

  it('does not touch a paper that uses a different reason', () => {
    const papers = [paper('Wrong topic')]
    const next = renameReasonInPapers(papers, 'Duplicate', 'X')
    expect(next[0]).toBe(papers[0])
  })
})
