import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import type { Paper, Project } from '../model/project'
import { agreementInput } from './agreement'
import { screeningSchemaDefs } from '../screening/schema'

const SCHEMA_DEFS: AnnotationDef[] = [
  { name: 'Study Type', type: 'string' },
  {
    name: 'Findings',
    min: 1,
    max: null,
    children: [{ name: 'Claim', type: 'string' }],
  },
]
const SCHEMA = resolveSchema(SCHEMA_DEFS)

function tree(data: AnnotationValueTree): AnnotationValueTree {
  return normalizeTree(SCHEMA, data)
}

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
    marks: [],
    reviewMarks: {},
    extra: {},
    ...overrides,
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    version: 1,
    provenance: null,
    protocol: null,
    schema: SCHEMA,
    aiEnabled: true,
    reviewers: 2,
    extra: {},
    papers: [],
    screening: null,
    ...overrides,
  }
}

describe('agreementInput', () => {
  it('excludes a field fewer than two reviewers answered, and counts it as skipped', () => {
    const project = makeProject({
      papers: [
        makePaper({
          reviews: {
            '1': tree({ 'Study Type': [{ value: 'RCT' }] }),
            '2': tree({}), // never answered
          },
        }),
      ],
    })
    const { input, unitCount, skipped } = agreementInput(project)
    expect(input.units).toHaveLength(0)
    expect(unitCount).toBe(0)
    // "Study Type" and "Findings/Claim" both fall short of two answers.
    expect(skipped).toBe(2)
  })

  it('carries each answering reviewer\'s category through into the unit', () => {
    const project = makeProject({
      papers: [
        makePaper({
          reviews: {
            '1': tree({ 'Study Type': [{ value: 'RCT' }] }),
            '2': tree({ 'Study Type': [{ value: 'Survey' }] }),
          },
        }),
      ],
    })
    const { input } = agreementInput(project)
    const unit = input.units.find((u) => u['1'] === 'rct')
    expect(unit).toBeDefined()
    expect(unit!['2']).toBe('survey')
  })

  it('a reviewer who did not answer reads as null in the unit, not a missing key', () => {
    const project = makeProject({
      reviewers: 3,
      papers: [
        makePaper({
          reviews: {
            '1': tree({ 'Study Type': [{ value: 'RCT' }] }),
            '2': tree({ 'Study Type': [{ value: 'RCT' }] }),
            '3': tree({}),
          },
        }),
      ],
    })
    const { input } = agreementInput(project)
    const unit = input.units.find((u) => u['1'] === 'rct')
    expect(unit!['3']).toBeNull()
  })

  it('a field the consolidator marked equal arrives as one shared category, not each wording', () => {
    const project = makeProject({
      papers: [
        makePaper({
          reviews: {
            '1': tree({ 'Study Type': [{ value: 'RCT' }] }),
            '2': tree({ 'Study Type': [{ value: 'Randomized controlled trial' }] }),
          },
          equal: ['Study Type'],
        }),
      ],
    })
    const { input } = agreementInput(project)
    const unit = input.units.find((u) => u['1'] !== null)
    expect(unit).toBeDefined()
    expect(unit!['1']).toBe(unit!['2'])
  })

  it('a project with no reviews at all skips every field and yields no units', () => {
    const project = makeProject({
      papers: [makePaper({ reviews: {} })],
    })
    const { input, unitCount, skipped } = agreementInput(project)
    expect(input.units).toHaveLength(0)
    expect(unitCount).toBe(0)
    expect(skipped).toBeGreaterThan(0)
  })

  it('raters are "1".."N" matching project.reviewers, regardless of who actually answered', () => {
    const project = makeProject({
      reviewers: 3,
      papers: [
        makePaper({
          reviews: {
            '1': tree({ 'Study Type': [{ value: 'RCT' }] }),
            '2': tree({ 'Study Type': [{ value: 'RCT' }] }),
          },
        }),
      ],
    })
    const { input } = agreementInput(project)
    expect(input.raters).toEqual(['1', '2', '3'])
  })
})

describe('agreementInput on a screening project', () => {
  const SCREENING_SCHEMA = resolveSchema(screeningSchemaDefs({ reasons: ['Wrong topic', 'Duplicate'] }))

  function screeningTree(decision?: string, reason?: string): AnnotationValueTree {
    return normalizeTree(SCREENING_SCHEMA, {
      Decision: decision === undefined ? [] : [{ value: decision }],
      Reason: reason === undefined ? [] : [{ value: reason }],
    })
  }

  function screeningProject(overrides: Partial<Project> = {}): Project {
    return {
      version: 1,
      provenance: null,
      protocol: null,
      schema: SCREENING_SCHEMA,
      aiEnabled: true,
      reviewers: 2,
      extra: {},
      papers: [],
      screening: { reasons: ['Wrong topic', 'Duplicate'] },
      ...overrides,
    }
  }

  it('units cover only the Decision field, never Reason', () => {
    const project = screeningProject({
      papers: [
        makePaper({
          reviews: {
            '1': screeningTree('Exclude', 'Duplicate'),
            '2': screeningTree('Exclude', 'Wrong topic'),
          },
        }),
      ],
    })
    const { input, unitCount } = agreementInput(project)
    expect(unitCount).toBe(1)
    expect(input.units).toHaveLength(1)
    // Both reviewers said "Exclude" — the one unit reflects that, not the
    // differing Reason wording.
    expect(input.units[0]['1']).toBe(input.units[0]['2'])
  })

  it('skipped counts only Decisions fewer than two reviewers answered, never Reason', () => {
    const project = screeningProject({
      papers: [
        makePaper({
          reviews: {
            '1': screeningTree('Exclude', 'Duplicate'),
            '2': screeningTree(), // never screened
          },
        }),
      ],
    })
    const { input, unitCount, skipped } = agreementInput(project)
    expect(unitCount).toBe(0)
    expect(input.units).toHaveLength(0)
    // If Reason were counted too this would be 2 (Decision + Reason).
    expect(skipped).toBe(1)
  })

  it('a non-screening project is unaffected — both Study Type and Findings/Claim are units', () => {
    const project = makeProject({
      papers: [
        makePaper({
          reviews: {
            '1': tree({ 'Study Type': [{ value: 'RCT' }] }),
            '2': tree({ 'Study Type': [{ value: 'RCT' }] }),
          },
        }),
      ],
    })
    const { unitCount } = agreementInput(project)
    expect(unitCount).toBe(1) // Findings/Claim: neither reviewer answered, so skipped, not a unit
  })
})

describe('agreementInput.perField', () => {
  it('keeps distinct fields apart, each with its own units', () => {
    const project = makeProject({
      papers: [
        makePaper({
          reviews: {
            '1': tree({
              'Study Type': [{ value: 'RCT' }],
              Findings: [{ children: { Claim: [{ value: 'A' }] } }],
            }),
            '2': tree({
              'Study Type': [{ value: 'Survey' }],
              Findings: [{ children: { Claim: [{ value: 'B' }] } }],
            }),
          },
        }),
      ],
    })
    const { perField } = agreementInput(project)
    const keys = perField.map((f) => f.key)
    expect(keys).toEqual(['Study Type', 'Findings/Claim'])
    expect(perField.find((f) => f.key === 'Study Type')!.unitCount).toBe(1)
    expect(perField.find((f) => f.key === 'Findings/Claim')!.unitCount).toBe(1)
  })

  it('pools a repeated field\'s instances across papers under one key', () => {
    const project = makeProject({
      papers: [
        makePaper({
          id: 'p1',
          reviews: {
            '1': tree({ Findings: [{ children: { Claim: [{ value: 'A' }] } }] }),
            '2': tree({ Findings: [{ children: { Claim: [{ value: 'A' }] } }] }),
          },
        }),
        makePaper({
          id: 'p2',
          reviews: {
            '1': tree({
              Findings: [
                { children: { Claim: [{ value: 'B' }] } },
                { children: { Claim: [{ value: 'C' }] } },
              ],
            }),
            '2': tree({
              Findings: [
                { children: { Claim: [{ value: 'B' }] } },
                { children: { Claim: [{ value: 'D' }] } },
              ],
            }),
          },
        }),
      ],
    })
    const { perField } = agreementInput(project)
    const findings = perField.find((f) => f.key === 'Findings/Claim')!
    // p1's one instance + p2's two instances = 3, and "Study Type" (0
    // answers anywhere) contributes nothing — pooled, not one row per paper.
    expect(findings.unitCount).toBe(3)
  })

  it('the label reads "Findings › Claim", ancestor-joined without instance numbers', () => {
    const project = makeProject({
      papers: [
        makePaper({
          reviews: {
            '1': tree({ Findings: [{ children: { Claim: [{ value: 'A' }] } }] }),
            '2': tree({ Findings: [{ children: { Claim: [{ value: 'A' }] } }] }),
          },
        }),
      ],
    })
    const { perField } = agreementInput(project)
    expect(perField.find((f) => f.key === 'Findings/Claim')!.label).toBe('Findings › Claim')
  })

  it('a screening project has exactly one per-field entry, for Decision', () => {
    const SCREENING_SCHEMA = resolveSchema(screeningSchemaDefs({ reasons: ['Wrong topic'] }))
    const project: Project = {
      version: 1,
      provenance: null,
      protocol: null,
      schema: SCREENING_SCHEMA,
      aiEnabled: true,
      reviewers: 2,
      extra: {},
      screening: { reasons: ['Wrong topic'] },
      papers: [
        makePaper({
          reviews: {
            '1': normalizeTree(SCREENING_SCHEMA, { Decision: [{ value: 'Exclude' }], Reason: [{ value: 'Wrong topic' }] }),
            '2': normalizeTree(SCREENING_SCHEMA, { Decision: [{ value: 'Exclude' }], Reason: [{ value: 'Wrong topic' }] }),
          },
        }),
      ],
    }
    const { perField } = agreementInput(project)
    expect(perField).toHaveLength(1)
    expect(perField[0].key).toBe('Decision')
  })
})

describe('boolean fields', () => {
  it('includes a true/false split as a disagreeing unit', () => {
    const schema = resolveSchema([
      { name: 'Kind', type: 'string' },
      { name: 'Relevant', type: 'boolean' },
    ])
    const t = (kind: string, rel: boolean) =>
      normalizeTree(schema, { Kind: [{ value: kind }], Relevant: [{ value: rel }] })

    const project = makeProject({
      schema,
      papers: [
        // Both agree on the first boolean.
        makePaper({ id: 'p1', reviews: { '1': t('RCT', true), '2': t('RCT', true) } }),
        // The second boolean is a real disagreement.
        makePaper({ id: 'p2', reviews: { '1': t('RCT', true), '2': t('Cohort', false) } }),
      ],
    })

    const built = agreementInput(project)
    expect(built.unitCount).toBe(4)
    expect(built.perField.find((field) => field.key === 'Relevant')?.unitCount).toBe(2)
    expect(built.input.units).toContainEqual({ '1': 'true', '2': 'false' })
  })
})
