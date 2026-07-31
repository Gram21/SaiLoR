import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import type { Paper, Project } from '../model/project'
import { screeningSchemaDefs, DECISION_EXCLUDE, DECISION_INCLUDE } from './schema'
import { screeningCounts, pendingUnanimous, pendingUnanimousDecisions } from './counts'

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
    alignment: {},
    marks: [],
    reviewMarks: {},
    finished: false,
    reviewsFinished: {},
    extra: {},
    ...overrides,
  }
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    version: 1,
    provenance: null,
    protocol: null,
    schemaInfo: null,
    schema: SCHEMA,
    aiEnabled: true,
    finishCheckbox: true,
    reviewers: 1,
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

  it('counts an inherited-member reason as "no reason recorded"', () => {
    // Screening files are hand-editable by design (and an LLM can write the
    // Reason field), so "constructor" is reachable. `reason in byReason` found
    // it on Object.prototype: the paper counted as excluded-with-a-reason,
    // byReason.constructor went NaN, and the reason table summed to 0 against
    // a non-zero excluded count — the paper vanished from the breakdown.
    for (const evil of ['constructor', 'toString', '__proto__', 'valueOf']) {
      const p = project({
        papers: [paper({ annotations: tree(DECISION_EXCLUDE, evil) })],
      })
      const c = screeningCounts(p, null)
      expect(c.excluded).toBe(1)
      expect(c.excludedWithoutReason).toBe(1)
      for (const n of Object.values(c.byReason)) expect(n).toBe(0)
    }
  })

  it('counts a paper whose only pending unanimity is the reason', () => {
    // The notice counted pending *Decision* fills while the button it offers
    // adopts everything unanimous. A consolidator who set Decision by hand but
    // left Reason blank produced a Reason fill and no Decision fill: no notice,
    // nothing offering to adopt the reason, and the paper booked as
    // excluded-without-a-reason permanently.
    const p = project({
      reviewers: 2,
      papers: [
        paper({
          annotations: tree(DECISION_EXCLUDE),
          reviews: {
            '1': tree(DECISION_EXCLUDE, 'Duplicate'),
            '2': tree(DECISION_EXCLUDE, 'Duplicate'),
          },
        }),
      ],
    })
    expect(pendingUnanimous(p)).toBe(1)
  })

  it('does not count an already-decided paper as having no final decision', () => {
    // The import dialog says "N of the not-yet-screened papers ... so this
    // project has no final decision for them". A paper the consolidator already
    // excluded, lacking only a unanimous reason, must not be counted there:
    // the sentence would promise that adopting changes an inclusion count that
    // is already settled. The panel's own notice still counts it, because the
    // "Adopt all" button beside it does fill that reason.
    const p = project({
      reviewers: 2,
      papers: [
        paper({
          annotations: tree(DECISION_EXCLUDE),
          reviews: {
            '1': tree(DECISION_EXCLUDE, 'Duplicate'),
            '2': tree(DECISION_EXCLUDE, 'Duplicate'),
          },
        }),
      ],
    })
    expect(pendingUnanimousDecisions(p)).toBe(0)
    expect(pendingUnanimous(p)).toBe(1)
  })

  it('counts an undecided paper both ways', () => {
    const p = project({
      reviewers: 2,
      papers: [
        paper({
          annotations: tree(),
          reviews: { '1': tree(DECISION_INCLUDE), '2': tree(DECISION_INCLUDE) },
        }),
      ],
    })
    expect(pendingUnanimousDecisions(p)).toBe(1)
    expect(pendingUnanimous(p)).toBe(1)
  })
})
