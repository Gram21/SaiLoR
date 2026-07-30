import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from './store'

/**
 * `setAnnotationFinished` — the annotation panel's "Annotation finished"
 * checkbox. It writes a per-seat declaration (`Paper.finished` /
 * `reviewsFinished`), not an edit to the annotation data, so it routes by seat
 * exactly like `setFieldValue` does but stays out of the undo stack.
 */

const project = (reviewers?: number) =>
  JSON.stringify({
    version: 1,
    config: {
      schema: [{ name: 'Study Type', type: 'string' }],
      ...(reviewers ? { reviewers } : {}),
    },
    papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
  })

const st = () => useStore.getState()
const paper = () => st().project!.papers[0]

describe('the paper a project opens on', () => {
  const REQUIRED = { name: 'A', type: 'string', required: true }
  const papers = (...specs: Record<string, unknown>[]) =>
    JSON.stringify({
      version: 1,
      config: { schema: [REQUIRED] },
      papers: specs.map((spec, i) => ({
        id: `p${i + 1}`,
        title: `P${i + 1}`,
        authors: [],
        pdf: `p${i + 1}.pdf`,
        ...spec,
      })),
    })
  const done = { annotations: { A: [{ value: 'x' }] }, finished: true }
  const open = (text: string) => {
    st().loadFromText(text, null, 'test.json')
    return st().currentPaperId
  }

  it('skips the papers this seat has already finished', () => {
    expect(open(papers(done, done, {}))).toBe('p3')
  })

  it('lands on a flagged paper — a finished mark that no longer holds still needs attention', () => {
    expect(open(papers(done, { finished: true }, {}))).toBe('p2')
  })

  it('lands on a partly-filled paper rather than skipping to an untouched one', () => {
    expect(open(papers(done, { annotations: { A: [{ value: 'x' }] } }, {}))).toBe('p2')
  })

  it('falls back to the first paper when every paper is finished', () => {
    // Nothing is left to land on, and an empty selection would greet a
    // completed review with "Select a paper to annotate".
    expect(open(papers(done, done))).toBe('p1')
  })

  it('opens on the first paper of a screening project, which has no finished state', () => {
    const screening = JSON.stringify({
      version: 1,
      config: { screening: { reasons: ['Wrong topic'] } },
      papers: [
        { id: 'p1', title: 'P1', authors: [], pdf: '', finished: true },
        { id: 'p2', title: 'P2', authors: [], pdf: '' },
      ],
    })
    expect(open(screening)).toBe('p1')
  })

  it('opens on the first paper when nobody has picked a seat yet', () => {
    // Multi-reviewer with no seat: which papers are finished is unanswerable,
    // so the list opens exactly as it did before this existed.
    const multi = JSON.stringify({
      version: 1,
      config: { schema: [REQUIRED], reviewers: 2 },
      papers: [
        { id: 'p1', title: 'P1', authors: [], pdf: 'a.pdf', reviewsFinished: { '1': true } },
        { id: 'p2', title: 'P2', authors: [], pdf: 'b.pdf' },
      ],
    })
    expect(st().currentReviewer).toBeNull()
    expect(open(multi)).toBe('p1')
  })

  it('handles an empty project without selecting anything', () => {
    expect(open(papers())).toBeNull()
  })
})

describe('setAnnotationFilter', () => {
  it('resets to "all" when a project is closed, so the next one opens unfiltered', () => {
    st().loadFromText(project(), null, 'test.json')
    st().setAnnotationFilter('finished')
    expect(st().annotationFilter).toBe('finished')
    st().closeProject()
    expect(st().annotationFilter).toBe('all')
  })
})

describe('setAnnotationFinished', () => {
  describe('single-reviewer', () => {
    beforeEach(() => {
      st().loadFromText(project(), null, 'test.json')
      st().selectPaper('p1')
    })

    it('ticks and unticks the consolidated flag, marking the project dirty', () => {
      expect(paper().finished).toBe(false)
      st().setAnnotationFinished(true)
      expect(paper().finished).toBe(true)
      expect(st().dirty).toBe(true)

      st().setAnnotationFinished(false)
      expect(paper().finished).toBe(false)
    })

    it('pushes no history entry of its own, and rides along in the snapshots undo/redo restore', () => {
      st().setFieldValue([], 'Study Type', 0, 'RCT')
      const past = st().past.length
      st().setAnnotationFinished(true)
      expect(st().past).toHaveLength(past)

      // The one undo reverts the field edit, and with it the state of the
      // paper as a whole — including a declaration that only made sense while
      // that value was there. Redo brings both back together.
      st().undo()
      expect(paper().annotations['Study Type'][0].value).toBeNull()
      expect(paper().finished).toBe(false)

      st().redo()
      expect(paper().annotations['Study Type'][0].value).toBe('RCT')
      expect(paper().finished).toBe(true)
    })
  })

  describe('multi-reviewer', () => {
    beforeEach(() => {
      st().loadFromText(project(2), null, 'test.json')
      st().selectPaper('p1')
    })

    it('writes to the active reviewer’s own flag, not the consolidated one', () => {
      st().selectReviewer('2')
      st().setAnnotationFinished(true)
      expect(paper().reviewsFinished).toEqual({ '2': true })
      expect(paper().finished).toBe(false)
    })

    it('removes the key on untick, so an undeclared seat leaves nothing behind', () => {
      st().selectReviewer('1')
      st().setAnnotationFinished(true)
      st().setAnnotationFinished(false)
      expect(paper().reviewsFinished).toEqual({})
    })

    it('writes the consolidated flag from the Consolidation seat', () => {
      st().selectReviewer('consolidation')
      st().setAnnotationFinished(true)
      expect(paper().finished).toBe(true)
      expect(paper().reviewsFinished).toEqual({})
    })

    it('leaves the annotation filter alone — a view, not data', () => {
      st().setAnnotationFilter('issues')
      st().selectReviewer('1')
      st().setAnnotationFinished(true)
      expect(st().annotationFilter).toBe('issues')
    })

    it('is a no-op before a seat is picked — an unattributed declaration means nothing', () => {
      expect(st().currentReviewer).toBeNull()
      st().setAnnotationFinished(true)
      expect(paper().finished).toBe(false)
      expect(paper().reviewsFinished).toEqual({})
      expect(st().dirty).toBe(false)
    })
  })
})
