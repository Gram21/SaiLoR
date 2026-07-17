import { describe, it, expect } from 'vitest'
import {
  screeningSchemaDefs,
  isScreening,
  SCREENING_DECISION,
  SCREENING_REASON,
  DECISION_INCLUDE,
  DECISION_EXCLUDE,
  DEFAULT_SCREENING_REASONS,
} from './schema'
import type { Project } from '../model/project'

describe('screeningSchemaDefs', () => {
  it('derives exactly Decision and Reason, in that order', () => {
    const defs = screeningSchemaDefs({ reasons: ['Wrong topic', 'Duplicate'] })
    expect(defs.map((d) => d.name)).toEqual([SCREENING_DECISION, SCREENING_REASON])
    expect(defs[0]).toMatchObject({
      name: SCREENING_DECISION,
      type: 'string',
      options: [DECISION_INCLUDE, DECISION_EXCLUDE],
    })
    expect(defs[1]).toMatchObject({
      name: SCREENING_REASON,
      type: 'string',
      options: ['Wrong topic', 'Duplicate'],
    })
  })

  it('carries the configured reasons into Reason.options in order', () => {
    const reasons = ['C', 'A', 'B']
    const defs = screeningSchemaDefs({ reasons })
    expect(defs[1].options).toEqual(['C', 'A', 'B'])
  })

  it('does not mutate the passed config array', () => {
    const reasons = ['One', 'Two']
    const defs = screeningSchemaDefs({ reasons })
    ;(defs[1].options as string[]).push('Three')
    expect(reasons).toEqual(['One', 'Two'])
  })

  it('writes no min/max, so the compact on-disk schema stays default (1)', () => {
    const defs = screeningSchemaDefs({ reasons: ['X'] })
    expect(defs[0].min).toBeUndefined()
    expect(defs[0].max).toBeUndefined()
    expect(defs[1].min).toBeUndefined()
    expect(defs[1].max).toBeUndefined()
  })
})

describe('isScreening', () => {
  const base = {
    version: 1,
    provenance: null,
    schema: [],
    aiEnabled: true,
    reviewers: 1,
    reviewerIdentities: {},
    papers: [],
    extra: {},
  }

  it('is true when config.screening is set', () => {
    const project: Project = { ...base, screening: { reasons: ['X'] } }
    expect(isScreening(project)).toBe(true)
  })

  it('is false for an ordinary project, and for null/undefined', () => {
    const project: Project = { ...base, screening: null }
    expect(isScreening(project)).toBe(false)
    expect(isScreening(null)).toBe(false)
    expect(isScreening(undefined)).toBe(false)
  })
})

describe('DEFAULT_SCREENING_REASONS', () => {
  it('is non-empty and includes an "Other" escape hatch', () => {
    expect(DEFAULT_SCREENING_REASONS.length).toBeGreaterThan(0)
    expect(DEFAULT_SCREENING_REASONS).toContain('Other')
  })
})
