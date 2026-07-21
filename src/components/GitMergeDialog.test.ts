import { describe, it, expect } from 'vitest'
import { isForeignReview } from './GitMergeDialog'
import type { MergeTree } from '../git/merge'

describe('isForeignReview (which merge rows "Use all mine" must not speak for)', () => {
  it('is foreign when the tree is another reviewer\'s own', () => {
    expect(isForeignReview({ kind: 'review', reviewer: '2' }, '1')).toBe(true)
  })

  it('is not foreign when the tree is the current seat\'s own', () => {
    expect(isForeignReview({ kind: 'review', reviewer: '1' }, '1')).toBe(false)
  })

  it('is foreign when nobody has picked a seat yet — no seat owns it', () => {
    expect(isForeignReview({ kind: 'review', reviewer: '1' }, null)).toBe(true)
  })

  const nonReviewTrees: MergeTree[] = [
    { kind: 'project' },
    { kind: 'paper' },
    { kind: 'annotations' },
  ]
  it.each(nonReviewTrees)('is never foreign for a non-review tree (%o)', (tree) => {
    expect(isForeignReview(tree, '1')).toBe(false)
    expect(isForeignReview(tree, null)).toBe(false)
  })
})
