import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import type { Paper, Project } from '../model/project'
import { agreementInput } from './agreement'

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
    extra: {},
    papers: [],
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
