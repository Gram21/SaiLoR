import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import type { Paper, Project } from '../model/project'
import { screeningSchemaDefs, DECISION_EXCLUDE, DECISION_INCLUDE } from './schema'
import { screeningCounts, pendingUnanimous } from './counts'

const REASONS = ['Wrong topic', 'Duplicate', 'Not in English']
const SCHEMA = resolveSchema(screeningSchemaDefs({ reasons: REASONS }))

function tree(decision?: string, reason?: string): AnnotationValueTree {
  return normalizeTree(SCHEMA, {
    Decision: decision === undefined ? [] : [{ value: decision }],
    Reason: reason === undefined ? [] : [{ value: reason }],
  })
}

let nextId = 0
function paper(overrides: Partial<Paper> = {}): Paper {
  nextId++
  return {
    id: `p${nextId}`,
    title: `Paper ${nextId}`,
    authors: [],
    pdf: '',
    annotations: {},
    reviews: {},
    aiUsage: [],
    equal: [],
    extra: {},
    ...overrides,
  }
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    version: 1,
    schema: SCHEMA,
    aiEnabled: true,
    reviewers: 1,
    reviewerIdentities: {},
    papers: [],
    screening: { reasons: REASONS },
    extra: {},
    ...overrides,
  }
}

describe('screeningCounts', () => {
  it('counts included / excluded / undecided, totalling every paper', () => {
    const p = project({
      papers: [
        paper({ annotations: tree(DECISION_INCLUDE) }),
        paper({ annotations: tree(DECISION_EXCLUDE, 'Duplicate') }),
        paper({ annotations: tree() }),
      ],
    })
    const counts = screeningCounts(p, null)
    expect(counts.total).toBe(3)
    expect(counts.included).toBe(1)
    expect(counts.excluded).toBe(1)
    expect(counts.undecided).toBe(1)
    expect(counts.included + counts.excluded + counts.undecided).toBe(counts.total)
  })

  it('byReason includes every configured reason, including ones nobody used', () => {
    const p = project({
      papers: [paper({ annotations: tree(DECISION_EXCLUDE, 'Duplicate') })],
    })
    const counts = screeningCounts(p, null)
    expect(counts.byReason).toEqual({ 'Wrong topic': 0, Duplicate: 1, 'Not in English': 0 })
  })

  it('an excluded paper with a reason not in the configured list lands in excludedWithoutReason', () => {
    const p = project({
      papers: [paper({ annotations: tree(DECISION_EXCLUDE, 'Some unlisted reason') })],
    })
    const counts = screeningCounts(p, null)
    expect(counts.excludedWithoutReason).toBe(1)
    expect(Object.values(counts.byReason).every((n) => n === 0)).toBe(true)
  })

  it('an excluded paper with no reason recorded lands in excludedWithoutReason', () => {
    const p = project({ papers: [paper({ annotations: tree(DECISION_EXCLUDE) })] })
    expect(screeningCounts(p, null).excludedWithoutReason).toBe(1)
  })

  it('counts differ per seat: Reviewer 1, Reviewer 2, and Consolidation can disagree', () => {
    const p = project({
      reviewers: 2,
      papers: [
        paper({
          annotations: tree(), // consolidation hasn't decided
          reviews: {
            '1': tree(DECISION_INCLUDE),
            '2': tree(DECISION_EXCLUDE, 'Duplicate'),
          },
        }),
      ],
    })
    expect(screeningCounts(p, '1').included).toBe(1)
    expect(screeningCounts(p, '2').excluded).toBe(1)
    expect(screeningCounts(p, 'consolidation').undecided).toBe(1)
  })
})

describe('pendingUnanimous', () => {
  it('is 0 for a single-reviewer project', () => {
    const p = project({ papers: [paper({ annotations: tree(DECISION_INCLUDE) })] })
    expect(pendingUnanimous(p)).toBe(0)
  })

  it('is 0 for a non-screening project', () => {
    const p = project({ screening: null, reviewers: 2 })
    expect(pendingUnanimous(p)).toBe(0)
  })

  it('counts a paper both reviewers included that Consolidation has not adopted', () => {
    const p = project({
      reviewers: 2,
      papers: [
        paper({
          annotations: tree(),
          reviews: { '1': tree(DECISION_INCLUDE), '2': tree(DECISION_INCLUDE) },
        }),
      ],
    })
    expect(pendingUnanimous(p)).toBe(1)
  })

  it('does not count a paper the reviewers disagreed on', () => {
    const p = project({
      reviewers: 2,
      papers: [
        paper({
          annotations: tree(),
          reviews: { '1': tree(DECISION_INCLUDE), '2': tree(DECISION_EXCLUDE, 'Duplicate') },
        }),
      ],
    })
    expect(pendingUnanimous(p)).toBe(0)
  })

  it('does not count a paper Consolidation already answered', () => {
    const p = project({
      reviewers: 2,
      papers: [
        paper({
          annotations: tree(DECISION_INCLUDE),
          reviews: { '1': tree(DECISION_INCLUDE), '2': tree(DECISION_INCLUDE) },
        }),
      ],
    })
    expect(pendingUnanimous(p)).toBe(0)
  })
})
