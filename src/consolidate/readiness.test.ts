import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import type { Paper } from '../model/project'
import { readyToConsolidate, readyCount, consolidatorHasAnswered, needsAlignment, needsAlignmentCount } from './readiness'

const DEFS: AnnotationDef[] = [
  { name: 'Study Type', type: 'string' },
  { name: 'Relevant', type: 'boolean' },
]
const schema = resolveSchema(DEFS)

function paper(reviews: Record<string, AnnotationValueTree>, id = 'p1'): Paper {
  const out: Record<string, AnnotationValueTree> = {}
  for (const [r, t] of Object.entries(reviews)) out[r] = normalizeTree(schema, t)
  return {
    id,
    title: 'A Paper',
    authors: [],
    pdf: 'a.pdf',
    // Deliberately full: the consolidated tree says nothing about whether the
    // *reviewers* have done their work, and must not be mistaken for it.
    annotations: normalizeTree(schema, { 'Study Type': [{ value: 'Survey' }] }),
    reviews: out,
    aiUsage: [],
    equal: [],
    alignment: {},
    marks: [],
    reviewMarks: {},
    finished: false,
    reviewsFinished: {},
    extra: {},
  }
}

describe('readyToConsolidate', () => {
  it('is true once every reviewer has annotated', () => {
    expect(
      readyToConsolidate(
        schema,
        paper({
          '1': { 'Study Type': [{ value: 'Survey' }] },
          '2': { 'Study Type': [{ value: 'Case study' }] },
        }),
        2,
      ),
    ).toBe(true)
  })

  it('is false while a reviewer has recorded nothing', () => {
    expect(
      readyToConsolidate(schema, paper({ '1': { 'Study Type': [{ value: 'Survey' }] }, '2': {} }), 2),
    ).toBe(false)
  })

  it('is false for a reviewer who has no tree at all', () => {
    expect(readyToConsolidate(schema, paper({ '1': { 'Study Type': [{ value: 'Survey' }] } }), 2)).toBe(
      false,
    )
  })

  it('does not mistake the consolidated tree for the reviewers\' work', () => {
    // Every fixture here has a filled `annotations`; readiness is about
    // `reviews`, and reading the wrong one would call every paper ready.
    expect(readyToConsolidate(schema, paper({}), 2)).toBe(false)
  })

  it('counts a ticked box as work, and an unticked one as nothing', () => {
    // Every boolean in the project reads `false` whether or not anyone looked,
    // so only a tick is evidence.
    expect(readyToConsolidate(schema, paper({ '1': { Relevant: [{ value: true }] }, '2': { Relevant: [{ value: true }] } }), 2)).toBe(true)
    expect(readyToConsolidate(schema, paper({ '1': { Relevant: [{ value: false }] }, '2': { Relevant: [{ value: false }] } }), 2)).toBe(false)
  })

  it('needs every reviewer, not just most of them', () => {
    const three = paper({
      '1': { 'Study Type': [{ value: 'a' }] },
      '2': { 'Study Type': [{ value: 'b' }] },
    })
    expect(readyToConsolidate(schema, three, 2)).toBe(true)
    expect(readyToConsolidate(schema, three, 3)).toBe(false)
  })

  it('counts the ready papers of a project', () => {
    const papers = [
      paper({ '1': { 'Study Type': [{ value: 'a' }] }, '2': { 'Study Type': [{ value: 'b' }] } }, 'p1'),
      paper({ '1': { 'Study Type': [{ value: 'a' }] } }, 'p2'),
      paper({}, 'p3'),
    ]
    expect(readyCount(schema, papers, 2)).toBe(1)
  })
})

describe('consolidatorHasAnswered', () => {
  const def = schema.find((d) => d.name === 'Study Type')!
  const boolDef = schema.find((d) => d.name === 'Relevant')!

  it('is true once the consolidator has written a value under the node', () => {
    const consolidated = normalizeTree(schema, { 'Study Type': [{ value: 'Survey' }] })
    expect(consolidatorHasAnswered(def, consolidated)).toBe(true)
  })

  it('is false for an empty (never-touched) node', () => {
    const consolidated = normalizeTree(schema, undefined)
    expect(consolidatorHasAnswered(def, consolidated)).toBe(false)
  })

  it('treats an unticked boolean as unanswered, same as hasAnnotations', () => {
    const consolidated = normalizeTree(schema, { Relevant: [{ value: false }] })
    expect(consolidatorHasAnswered(boolDef, consolidated)).toBe(false)
  })

  it('treats a ticked boolean as answered', () => {
    const consolidated = normalizeTree(schema, { Relevant: [{ value: true }] })
    expect(consolidatorHasAnswered(boolDef, consolidated)).toBe(true)
  })

  it('tolerates a tree with no entry at all for the node', () => {
    expect(consolidatorHasAnswered(def, {} as AnnotationValueTree)).toBe(false)
  })
})

describe('needsAlignment', () => {
  const REPEATABLE_DEFS: AnnotationDef[] = [
    { name: 'Study Type', type: 'string' },
    { name: 'Findings', min: 0, max: null, children: [{ name: 'Claim', type: 'string' }] },
  ]
  const repeatSchema = resolveSchema(REPEATABLE_DEFS)

  function paperWith(
    reviews: Record<string, AnnotationValueTree>,
    consolidated: AnnotationValueTree = {},
    id = 'p1',
  ): Paper {
    const out: Record<string, AnnotationValueTree> = {}
    for (const [r, t] of Object.entries(reviews)) out[r] = normalizeTree(repeatSchema, t)
    return {
      id,
      title: 'A Paper',
      authors: [],
      pdf: 'a.pdf',
      annotations: normalizeTree(repeatSchema, consolidated),
      reviews: out,
      aiUsage: [],
      equal: [],
      alignment: {},
      marks: [],
      reviewMarks: {},
      finished: false,
      reviewsFinished: {},
      extra: {},
    }
  }

  const twoReviewersWithFindings = {
    '1': { Findings: [{ children: { Claim: [{ value: 'A' }] } }] },
    '2': {
      Findings: [{ children: { Claim: [{ value: 'B' }] } }, { children: { Claim: [{ value: 'C' }] } }],
    },
  }

  it('is true when two reviewers recorded Findings and nobody has lined them up', () => {
    expect(needsAlignment(repeatSchema, paperWith(twoReviewersWithFindings), 2)).toBe(true)
  })

  it('is false once the consolidator has answered under the node (alignment is frozen, treated as done)', () => {
    const p = paperWith(twoReviewersWithFindings, { Findings: [{ children: { Claim: [{ value: 'A' }] } }] })
    expect(needsAlignment(repeatSchema, p, 2)).toBe(false)
  })

  it('is false when fewer than two reviewers recorded anything under the node', () => {
    const p = paperWith({ '1': { Findings: [{ children: { Claim: [{ value: 'A' }] } }] }, '2': {} })
    expect(needsAlignment(repeatSchema, p, 2)).toBe(false)
  })

  it('is false for a paper with no repeatable content at all', () => {
    const p = paperWith({ '1': { 'Study Type': [{ value: 'a' }] }, '2': { 'Study Type': [{ value: 'b' }] } })
    expect(needsAlignment(repeatSchema, p, 2)).toBe(false)
  })

  it('needsAlignmentCount tallies across a project', () => {
    const papers = [
      paperWith(twoReviewersWithFindings, {}, 'p1'),
      paperWith(twoReviewersWithFindings, { Findings: [{ children: { Claim: [{ value: 'A' }] } }] }, 'p2'),
      paperWith({ '1': { 'Study Type': [{ value: 'a' }] } }, {}, 'p3'),
    ]
    expect(needsAlignmentCount(repeatSchema, papers, 2)).toBe(1)
  })
})
