import { describe, it, expect } from 'vitest'
import { paperIsMarkedDone } from './PaperList'
import { resolveSchema } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import type { Paper, Project } from '../model/project'

/**
 * `paperIsMarkedDone` decides the paper-list status dot. Its one nontrivial
 * case is Consolidation: `adoptUnanimousValues` (see store.ts) fills
 * `paper.annotations` just from opening the paper, so "does `paper.annotations`
 * have anything in it" is no longer a signal the consolidator produced — the
 * dot has to mean "every numbered reviewer has answered" instead, read
 * straight from `paper.reviews`, independent of what auto-adoption wrote.
 */

const schema = resolveSchema([
  { name: 'Study Type', type: 'string' },
  { name: 'Relevant', type: 'boolean' },
])

function emptyTree(): AnnotationValueTree {
  return normalizeTree(schema, undefined)
}

function filledTree(): AnnotationValueTree {
  const tree = normalizeTree(schema, undefined)
  tree['Study Type'][0].value = 'RCT'
  return tree
}

function makeProject(reviewers: number): Project {
  return {
    version: 1,
    schema,
    aiEnabled: true,
    reviewers,
    reviewerIdentities: {},
    papers: [],
    screening: null,
    extra: {},
  }
}

function makePaper(opts: {
  annotations?: AnnotationValueTree
  reviews?: Record<string, AnnotationValueTree>
}): Paper {
  return {
    id: 'p1',
    title: 'A Paper',
    authors: [],
    pdf: 'a.pdf',
    annotations: opts.annotations ?? emptyTree(),
    reviews: opts.reviews ?? {},
    aiUsage: [],
    equal: [],
    extra: {},
  }
}

describe('paperIsMarkedDone', () => {
  describe('single-reviewer project', () => {
    const project = makeProject(1)

    it('is false with no annotations, unchanged from plain hasAnnotations', () => {
      const paper = makePaper({ annotations: emptyTree() })
      expect(paperIsMarkedDone(project, paper, null)).toBe(false)
    })

    it('is true once paper.annotations has a value, unchanged from plain hasAnnotations', () => {
      const paper = makePaper({ annotations: filledTree() })
      expect(paperIsMarkedDone(project, paper, null)).toBe(true)
    })
  })

  describe('a numbered reviewer', () => {
    const project = makeProject(3)

    it('reflects that reviewer’s own tree', () => {
      const paper = makePaper({ reviews: { '1': filledTree() } })
      expect(paperIsMarkedDone(project, paper, '1')).toBe(true)
    })

    it('is false for a reviewer with no tree of their own, even if paper.annotations is full', () => {
      const paper = makePaper({ annotations: filledTree(), reviews: { '1': filledTree() } })
      expect(paperIsMarkedDone(project, paper, '2')).toBe(false)
    })
  })

  describe('multi-reviewer, nobody picked yet', () => {
    it('is false — there is nothing to read until a reviewer is selected', () => {
      const project = makeProject(2)
      const paper = makePaper({ annotations: filledTree() })
      expect(paperIsMarkedDone(project, paper, null)).toBe(false)
    })
  })

  describe('Consolidation', () => {
    const project = makeProject(3)

    it('is false when only some reviewers have annotated', () => {
      const paper = makePaper({
        reviews: { '1': filledTree(), '2': filledTree() }, // reviewer 3 never opened it
      })
      expect(paperIsMarkedDone(project, paper, 'consolidation')).toBe(false)
    })

    it('is true once every numbered reviewer has annotated', () => {
      const paper = makePaper({
        reviews: { '1': filledTree(), '2': filledTree(), '3': filledTree() },
      })
      expect(paperIsMarkedDone(project, paper, 'consolidation')).toBe(true)
    })

    it('is false even when paper.annotations is full, if a reviewer has not annotated — the regression', () => {
      // This is exactly what `adoptUnanimousValues` produces: it fills
      // `paper.annotations` from whichever reviewers agree, which can happen
      // well before every reviewer has actually opened the paper. The dot
      // must not read this tree at all in this seat.
      const paper = makePaper({
        annotations: filledTree(),
        reviews: { '1': filledTree(), '2': emptyTree() }, // reviewer 3 has no tree at all
      })
      expect(paperIsMarkedDone(project, paper, 'consolidation')).toBe(false)
    })
  })
})
