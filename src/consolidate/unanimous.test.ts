import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import { unanimousFills } from './unanimous'

function setup(defs: AnnotationDef[], raw: Record<string, AnnotationValueTree | undefined>, cons: AnnotationValueTree = {}) {
  const schema = resolveSchema(defs)
  const reviews: Record<string, AnnotationValueTree | undefined> = {}
  for (const [r, tree] of Object.entries(raw)) {
    reviews[r] = tree === undefined ? undefined : normalizeTree(schema, tree)
  }
  return { schema, reviews, consolidated: normalizeTree(schema, cons) }
}

const SIMPLE: AnnotationDef[] = [
  { name: 'Study Type', type: 'string' },
  { name: 'Year', type: 'number' },
  { name: 'Relevant', type: 'boolean' },
]

/** Just the bits a caller acts on, for readable assertions. */
function fillsOf(defs: AnnotationDef[], raw: Record<string, AnnotationValueTree | undefined>, cons: AnnotationValueTree = {}) {
  const { schema, reviews, consolidated } = setup(defs, raw, cons)
  return unanimousFills(schema, reviews, consolidated).map((f) => ({
    canonical: f.canonical,
    value: f.value,
  }))
}

describe('unanimousFills', () => {
  it('adopts a value every reviewer gave', () => {
    expect(
      fillsOf(SIMPLE, {
        '1': { 'Study Type': [{ value: 'Controlled experiment' }] },
        '2': { 'Study Type': [{ value: 'Controlled experiment' }] },
      }),
    ).toEqual([{ canonical: 'Study Type', value: 'Controlled experiment' }])
  })

  it('ignores case and stray whitespace, which is how one answer gets typed twice', () => {
    const fills = fillsOf(SIMPLE, {
      '1': { 'Study Type': [{ value: '  Controlled Experiment ' }] },
      '2': { 'Study Type': [{ value: 'controlled  experiment' }] },
    })
    expect(fills).toHaveLength(1)
    // Reviewer 1's wording, trimmed — deterministic rather than arbitrary.
    expect(fills[0].value).toBe('Controlled Experiment')
  })

  it('does not adopt when the reviewers actually differ', () => {
    expect(
      fillsOf(SIMPLE, {
        '1': { 'Study Type': [{ value: 'Case study' }] },
        '2': { 'Study Type': [{ value: 'Survey' }] },
      }),
    ).toEqual([])
  })

  it('does not treat a blank as agreement', () => {
    // Two agree, one has not got there yet. Silence is not assent.
    expect(
      fillsOf(SIMPLE, {
        '1': { 'Study Type': [{ value: 'Survey' }] },
        '2': { 'Study Type': [{ value: 'Survey' }] },
        '3': { 'Study Type': [{ value: null }] },
      }),
    ).toEqual([])
  })

  it('does not treat a reviewer who never opened the paper as agreeing', () => {
    expect(
      fillsOf(SIMPLE, {
        '1': { 'Study Type': [{ value: 'Survey' }] },
        '2': { 'Study Type': [{ value: 'Survey' }] },
        '3': undefined,
      }),
    ).toEqual([])
  })

  it('needs more than one reviewer to agree with', () => {
    expect(fillsOf(SIMPLE, { '1': { 'Study Type': [{ value: 'Survey' }] } })).toEqual([])
  })

  it('leaves a field the consolidator already answered alone', () => {
    expect(
      fillsOf(
        SIMPLE,
        {
          '1': { 'Study Type': [{ value: 'Survey' }] },
          '2': { 'Study Type': [{ value: 'Survey' }] },
        },
        { 'Study Type': [{ value: 'My own call' }] },
      ),
    ).toEqual([])
  })

  it('adopts a boolean everyone ticked', () => {
    expect(
      fillsOf(SIMPLE, {
        '1': { Relevant: [{ value: true }] },
        '2': { Relevant: [{ value: true }] },
      }),
    ).toEqual([{ canonical: 'Relevant', value: true }])
  })

  it('does not adopt a box nobody ticked', () => {
    // Every untouched boolean in the project reads `false`. Counting those as a
    // unanimous "no" would mark every checkbox on every paper and bury the real
    // agreements — and it would be a lie: nobody actually said no.
    expect(
      fillsOf(SIMPLE, {
        '1': { Relevant: [{ value: false }] },
        '2': { Relevant: [{ value: false }] },
      }),
    ).toEqual([])
  })

  it('adopts equal numbers, and only equal ones', () => {
    expect(
      fillsOf(SIMPLE, { '1': { Year: [{ value: 2024 }] }, '2': { Year: [{ value: 2024 }] } }),
    ).toEqual([{ canonical: 'Year', value: 2024 }])
    expect(
      fillsOf(SIMPLE, { '1': { Year: [{ value: 2024 }] }, '2': { Year: [{ value: 2025 }] } }),
    ).toEqual([])
  })

  it('does not fuzzy-match: near-agreement is the consolidator\'s call', () => {
    // The matcher uses fuzzy similarity to *pair* entries; adopting a value into
    // the final result unasked is a higher bar and demands the same answer.
    expect(
      fillsOf(SIMPLE, {
        '1': { 'Study Type': [{ value: 'Controlled experiment' }] },
        '2': { 'Study Type': [{ value: 'Controlled experiments' }] },
      }),
    ).toEqual([])
  })

  it('reaches fields nested inside repeated groups, per entry', () => {
    const defs: AnnotationDef[] = [
      {
        name: 'Findings',
        max: null,
        children: [
          { name: 'Claim', type: 'string' },
          { name: 'Evidence', type: 'string' },
        ],
      },
    ]
    const f = (claim: string, evidence: string) => ({
      children: { Claim: [{ value: claim }], Evidence: [{ value: evidence }] },
    })
    // Entry 0: both agree throughout. Entry 1: agree on Claim, differ on Evidence.
    const fills = fillsOf(
      defs,
      {
        '1': { Findings: [f('Alpha', 'Table 1'), f('Beta', 'Table 2')] },
        '2': { Findings: [f('Alpha', 'Table 1'), f('Beta', 'Figure 9')] },
      },
      { Findings: [{}, {}] },
    )
    expect(fills).toEqual([
      { canonical: 'Findings/Claim', value: 'Alpha' },
      { canonical: 'Findings/Evidence', value: 'Table 1' },
      { canonical: 'Findings[1]/Claim', value: 'Beta' },
    ])
  })

  it('only fills entries the consolidated tree actually has', () => {
    // It is grown by `applyAlignment` first; this must not invent entries of
    // its own beyond what is there.
    const defs: AnnotationDef[] = [
      { name: 'Findings', max: null, children: [{ name: 'Claim', type: 'string' }] },
    ]
    const f = (claim: string) => ({ children: { Claim: [{ value: claim }] } })
    const fills = fillsOf(
      defs,
      {
        '1': { Findings: [f('Alpha'), f('Beta')] },
        '2': { Findings: [f('Alpha'), f('Beta')] },
      },
      { Findings: [{}] },
    )
    expect(fills).toEqual([{ canonical: 'Findings/Claim', value: 'Alpha' }])
  })

  it('handles a malformed hand-edited tree rather than throwing', () => {
    const { schema, consolidated } = setup(SIMPLE, {}, {})
    const junk = { 'Study Type': 'not a list' } as unknown as AnnotationValueTree
    expect(() => unanimousFills(schema, { '1': junk, '2': junk }, consolidated)).not.toThrow()
  })
})
