import { describe, it, expect } from 'vitest'
import { loadProject, type Project } from '../model/project'
import type { AnnotationDef } from '../model/schema'
import { paperCompleteness } from './PaperList'

/**
 * `paperCompleteness` is the single place that decides whether the paper
 * list's dot fill applies to the current seat at all — see its doc comment
 * and `completenessApplies` in `PaperList.tsx`. Separate file from
 * `PaperList.test.ts` (which already covers `paperIsMarkedDone`) rather than
 * added to it, so this stream's diff does not touch a file a sibling change
 * could also be touching.
 */

const SCHEMA: AnnotationDef[] = [
  { name: 'Study Type', type: 'string', required: true },
  { name: 'Notes', type: 'string' },
]

function project(opts: {
  reviewers?: number
  screening?: { reasons: string[] }
  annotations?: Record<string, unknown>
  reviews?: Record<string, unknown>
}): Project {
  const config: Record<string, unknown> = opts.screening
    ? { screening: opts.screening }
    : { schema: SCHEMA }
  if (opts.reviewers !== undefined) config.reviewers = opts.reviewers
  return loadProject({
    version: 1,
    config,
    papers: [
      {
        id: 'p1',
        title: 'Paper 1',
        authors: [],
        pdf: 'p1.pdf',
        annotations: opts.annotations ?? {},
        ...(opts.reviews ? { reviews: opts.reviews } : {}),
      },
    ],
  })
}

describe('paperCompleteness', () => {
  it('is null for a screening project, regardless of seat', () => {
    const p = project({ screening: { reasons: ['Wrong topic'] } })
    expect(paperCompleteness(p, p.papers[0], null)).toBeNull()
  })

  it('is null for a screening project even in a numbered reviewer seat', () => {
    const p = project({ screening: { reasons: ['Wrong topic'] }, reviewers: 2 })
    expect(paperCompleteness(p, p.papers[0], '1')).toBeNull()
  })

  it('is null in the Consolidation seat of a multi-reviewer project', () => {
    const p = project({ reviewers: 3 })
    expect(paperCompleteness(p, p.papers[0], 'consolidation')).toBeNull()
  })

  it('is computed normally for a single-reviewer project', () => {
    const p = project({ annotations: { 'Study Type': [{ value: 'RCT' }] } })
    expect(paperCompleteness(p, p.papers[0], null)).toEqual({ filled: 1, total: 1 })
  })

  it('is computed normally for a numbered reviewer, from that reviewer’s own tree', () => {
    const p = project({
      reviewers: 2,
      reviews: { '1': { 'Study Type': [{ value: 'RCT' }] } },
    })
    expect(paperCompleteness(p, p.papers[0], '1')).toEqual({ filled: 1, total: 1 })
    expect(paperCompleteness(p, p.papers[0], '2')).toEqual({ filled: 0, total: 1 })
  })

  it('"consolidation" is not special-cased for a single-reviewer project — reviewers <= 1 never triggers the Consolidation gate', () => {
    const p = project({ annotations: { 'Study Type': [{ value: 'RCT' }] } })
    // `currentReviewer` is meaningless in a single-reviewer project, but the
    // gate is keyed on `project.reviewers > 1`, matching `paperIsMarkedDone`
    // and `currentTree`'s own routing.
    expect(paperCompleteness(p, p.papers[0], 'consolidation')).toEqual({ filled: 1, total: 1 })
  })
})
