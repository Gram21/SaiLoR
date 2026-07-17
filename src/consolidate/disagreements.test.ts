import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef, type ResolvedDef } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import type { Paper, Project } from '../model/project'
import { paperVerdicts, projectVerdicts } from './disagreements'

const SCHEMA_DEFS: AnnotationDef[] = [
  { name: 'Study Type', type: 'string' },
  { name: 'Relevant', type: 'boolean' },
  {
    name: 'Findings',
    min: 1,
    max: null,
    children: [
      { name: 'Claim', type: 'string' },
      { name: 'Evidence', min: 1, max: null, children: [{ name: 'Metric', type: 'string' }] },
    ],
  },
]
const SCHEMA = resolveSchema(SCHEMA_DEFS)

function tree(defs: ResolvedDef[], data: AnnotationValueTree): AnnotationValueTree {
  return normalizeTree(defs, data)
}

/** Everything `paperVerdicts` needs from a Paper and nothing else — the rest
 *  of the fields it never reads. */
function makePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: 'p1',
    title: 'Paper One',
    authors: [],
    pdf: 'p1.pdf',
    annotations: {},
    reviews: {},
    aiUsage: [],
    equal: [],
    extra: {},
    ...overrides,
  }
}

function verdictOf(paper: Paper, canonical: string, reviewerCount = 2, schema = SCHEMA) {
  const v = paperVerdicts(schema, paper, reviewerCount).find((v) => v.canonical === canonical)
  if (!v) throw new Error(`no verdict for "${canonical}"`)
  return v
}

describe('paperVerdicts', () => {
  it('agrees when both reviewers give the exact same answer', () => {
    const paper = makePaper({
      reviews: {
        '1': tree(SCHEMA, { 'Study Type': [{ value: 'RCT' }] }),
        '2': tree(SCHEMA, { 'Study Type': [{ value: 'RCT' }] }),
      },
    })
    const v = verdictOf(paper, 'Study Type')
    expect(v.answeredBy.slice().sort()).toEqual(['1', '2'])
    expect(v.agree).toBe(true)
    expect(v.markedEqual).toBe(false)
  })

  it('disagrees when reviewers give different answers', () => {
    const paper = makePaper({
      reviews: {
        '1': tree(SCHEMA, { 'Study Type': [{ value: 'RCT' }] }),
        '2': tree(SCHEMA, { 'Study Type': [{ value: 'Survey' }] }),
      },
    })
    const v = verdictOf(paper, 'Study Type')
    expect(v.agree).toBe(false)
    expect(v.categories['1']).not.toBe(v.categories['2'])
  })

  it('treats case and stray whitespace as agreement, same rule unanimous.ts uses', () => {
    const paper = makePaper({
      reviews: {
        '1': tree(SCHEMA, { 'Study Type': [{ value: 'Randomized Controlled Trial' }] }),
        '2': tree(SCHEMA, { 'Study Type': [{ value: '  randomized  controlled trial ' }] }),
      },
    })
    expect(verdictOf(paper, 'Study Type').agree).toBe(true)
  })

  it('does not fuzzy-match beyond case/whitespace: a near-miss still disagrees', () => {
    const paper = makePaper({
      reviews: {
        '1': tree(SCHEMA, { 'Study Type': [{ value: 'Controlled experiment' }] }),
        '2': tree(SCHEMA, { 'Study Type': [{ value: 'Controlled experiments' }] }),
      },
    })
    expect(verdictOf(paper, 'Study Type').agree).toBe(false)
  })

  it('a marked-equal field reads as agreement even though the raw text differs', () => {
    const paper = makePaper({
      reviews: {
        '1': tree(SCHEMA, { 'Study Type': [{ value: 'RCT' }] }),
        '2': tree(SCHEMA, { 'Study Type': [{ value: 'Randomized controlled trial' }] }),
      },
      equal: ['Study Type'],
    })
    const v = verdictOf(paper, 'Study Type')
    expect(v.markedEqual).toBe(true)
    expect(v.agree).toBe(true)
    // One shared synthetic category, not each reviewer's own wording.
    expect(v.categories['1']).toBe(v.categories['2'])
  })

  it('a mark on a different field does not bleed into this one', () => {
    const paper = makePaper({
      reviews: {
        '1': tree(SCHEMA, { 'Study Type': [{ value: 'RCT' }] }),
        '2': tree(SCHEMA, { 'Study Type': [{ value: 'Survey' }] }),
      },
      equal: ['Findings/Claim'],
    })
    const v = verdictOf(paper, 'Study Type')
    expect(v.markedEqual).toBe(false)
    expect(v.agree).toBe(false)
  })

  it('a field only one reviewer answered carries no agreement information, but still appears', () => {
    const paper = makePaper({
      reviews: {
        '1': tree(SCHEMA, { 'Study Type': [{ value: 'RCT' }] }),
        '2': tree(SCHEMA, {}),
      },
    })
    const v = verdictOf(paper, 'Study Type')
    expect(v.answeredBy).toEqual(['1'])
    expect(v.answeredBy.length).toBeLessThan(2) // the caller's exclusion gate
    expect(v.agree).toBe(true) // vacuous, not a disagreement — but not meaningful either
  })

  it('a field nobody answered still gets a verdict, not an absence', () => {
    const paper = makePaper({
      reviews: { '1': tree(SCHEMA, {}), '2': tree(SCHEMA, {}) },
    })
    const v = verdictOf(paper, 'Study Type')
    expect(v.answeredBy).toEqual([])
    expect(v.values).toEqual({ '1': null, '2': null })
  })

  it('walks nested repeatable groups, comparing entries by matched index', () => {
    const finding = (claim: string, metric: string) => ({
      children: {
        Claim: [{ value: claim }],
        Evidence: [{ children: { Metric: [{ value: metric }] } }],
      },
    })
    const paper = makePaper({
      reviews: {
        '1': tree(SCHEMA, { Findings: [finding('Alpha', 'x')] }),
        '2': tree(SCHEMA, { Findings: [finding('Alpha', 'y')] }),
      },
    })
    const verdicts = paperVerdicts(SCHEMA, paper, 2)
    expect(verdicts.find((v) => v.canonical === 'Findings/Claim')?.agree).toBe(true)
    expect(verdicts.find((v) => v.canonical === 'Findings/Evidence/Metric')?.agree).toBe(false)
  })

  it('extends the walk to a second entry once a reviewer records one', () => {
    const finding = (claim: string) => ({ children: { Claim: [{ value: claim }] } })
    const paper = makePaper({
      reviews: {
        '1': tree(SCHEMA, { Findings: [finding('Alpha'), finding('Beta')] }),
        '2': tree(SCHEMA, { Findings: [finding('Alpha')] }),
      },
    })
    const verdicts = paperVerdicts(SCHEMA, paper, 2)
    const second = verdicts.find((v) => v.canonical === 'Findings[1]/Claim')
    expect(second).toBeDefined()
    expect(second!.answeredBy).toEqual(['1']) // reviewer 2 has nothing at index 1
  })

  it('treats an unticked boolean as unanswered, not a disagreeing "false"', () => {
    const paper = makePaper({
      reviews: {
        '1': tree(SCHEMA, { Relevant: [{ value: true }] }),
        '2': tree(SCHEMA, {}), // never ticked
      },
    })
    const v = verdictOf(paper, 'Relevant')
    expect(v.answeredBy).toEqual(['1'])
  })

  it('agrees on a boolean both reviewers ticked', () => {
    const paper = makePaper({
      reviews: {
        '1': tree(SCHEMA, { Relevant: [{ value: true }] }),
        '2': tree(SCHEMA, { Relevant: [{ value: true }] }),
      },
    })
    const v = verdictOf(paper, 'Relevant')
    expect(v.answeredBy.slice().sort()).toEqual(['1', '2'])
    expect(v.agree).toBe(true)
  })

  it('does not throw on a malformed hand-edited review tree', () => {
    const paper = makePaper({
      reviews: {
        '1': { 'Study Type': 'not-an-array' } as unknown as AnnotationValueTree,
        '2': null as unknown as AnnotationValueTree,
      },
    })
    expect(() => paperVerdicts(SCHEMA, paper, 2)).not.toThrow()
  })

  it('lists fields in schema order', () => {
    const paper = makePaper({
      reviews: {
        '1': tree(SCHEMA, {}),
        '2': tree(SCHEMA, {}),
      },
    })
    const canonicals = paperVerdicts(SCHEMA, paper, 2).map((v) => v.canonical)
    expect(canonicals).toEqual([
      'Study Type',
      'Relevant',
      'Findings/Claim',
      'Findings/Evidence/Metric',
    ])
  })
})

describe('projectVerdicts', () => {
  it('covers every paper in the project', () => {
    const project: Project = {
      version: 1,
      provenance: null,
      schema: SCHEMA,
      aiEnabled: true,
      reviewers: 2,
      extra: {},
      screening: null,
      papers: [
        makePaper({
          id: 'p1',
          title: 'One',
          reviews: {
            '1': tree(SCHEMA, { 'Study Type': [{ value: 'RCT' }] }),
            '2': tree(SCHEMA, { 'Study Type': [{ value: 'RCT' }] }),
          },
        }),
        makePaper({
          id: 'p2',
          title: 'Two',
          reviews: {
            '1': tree(SCHEMA, { 'Study Type': [{ value: 'Survey' }] }),
            '2': tree(SCHEMA, { 'Study Type': [{ value: 'Case study' }] }),
          },
        }),
      ],
    }
    const verdicts = projectVerdicts(project)
    expect(verdicts.filter((v) => v.paperId === 'p1' && v.canonical === 'Study Type')[0].agree).toBe(true)
    expect(verdicts.filter((v) => v.paperId === 'p2' && v.canonical === 'Study Type')[0].agree).toBe(false)
    expect(verdicts.filter((v) => v.paperId === 'p2')[0].paperTitle).toBe('Two')
  })
})
