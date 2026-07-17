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
    extra: {},
    ...overrides,
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    version: 1,
    schema: SCHEMA,
    aiEnabled: true,
    reviewers: 2,
    reviewerIdentities: {},
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
      schema: SCREENING_SCHEMA,
      aiEnabled: true,
      reviewers: 2,
      reviewerIdentities: {},
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
