import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import type { Paper, Project } from '../model/project'
import { screeningSchemaDefs, DECISION_EXCLUDE, DECISION_INCLUDE } from './schema'
import { screeningIssues } from './validate'

const REASONS = ['Wrong topic', 'Duplicate']
const SCHEMA = resolveSchema(screeningSchemaDefs({ reasons: REASONS }))

function tree(decision?: string, reason?: string): AnnotationValueTree {
  return normalizeTree(SCHEMA, {
    Decision: decision === undefined ? [] : [{ value: decision }],
    Reason: reason === undefined ? [] : [{ value: reason }],
  })
}

function paper(annotations: AnnotationValueTree): Paper {
  return {
    id: 'p1',
    title: 'Paper One',
    authors: [],
    pdf: '',
    annotations,
    reviews: {},
    aiUsage: [],
    equal: [],
    extra: {},
  }
}

function project(papers: Paper[]): Project {
  return {
    version: 1,
    provenance: null,
    schema: SCHEMA,
    aiEnabled: true,
    reviewers: 1,
    papers,
    screening: { reasons: REASONS },
    extra: {},
  }
}

describe('screeningIssues', () => {
  it('flags Exclude with no reason recorded', () => {
    const issues = screeningIssues(project([paper(tree(DECISION_EXCLUDE))]), null)
    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('screening')
    expect(issues[0].message).toMatch(/no exclusion reason/i)
  })

  it('flags a reason recorded on a paper that is not excluded', () => {
    const issues = screeningIssues(project([paper(tree(DECISION_INCLUDE, 'Duplicate'))]), null)
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toMatch(/not excluded/i)
  })

  it('does not flag an undecided paper', () => {
    expect(screeningIssues(project([paper(tree())]), null)).toEqual([])
  })

  it('does not flag a clean Include with no reason', () => {
    expect(screeningIssues(project([paper(tree(DECISION_INCLUDE))]), null)).toEqual([])
  })

  it('does not flag a clean Exclude with a reason', () => {
    expect(screeningIssues(project([paper(tree(DECISION_EXCLUDE, 'Wrong topic'))]), null)).toEqual([])
  })

  it('reports a malformed tree as no issues rather than throwing', () => {
    const malformed = paper({ Decision: 'not-a-list' as never })
    expect(() => screeningIssues(project([malformed]), null)).not.toThrow()
  })
})
