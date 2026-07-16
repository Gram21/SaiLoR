import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import type { Paper } from '../model/project'
import { readyToConsolidate, readyCount } from './readiness'

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
