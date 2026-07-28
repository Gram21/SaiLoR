import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'

/**
 * `addHighlight`/`setMarkComment`/`setMarkColor`/`removeMark`: the store side
 * of PDF highlights and comments. Routed through `currentMarks` exactly like
 * `currentTree` routes annotation answers — single-reviewer/Consolidation
 * share `paper.marks`, each other reviewer gets their own
 * `paper.reviewMarks[n]`. Deliberately outside the annotation undo stack (see
 * `pdfMarks.ts`'s doc comment) — these tests only assert `dirty`, never `past`.
 */

const mockPlatform = {
  kind: 'browser' as const,
  getOsInfo: () => null,
  getRecents: () => [] as RecentEntry[],
  rememberProject: () => {},
  forgetRecent: () => [] as RecentEntry[],
  checkRecents: async (entries: RecentEntry[]) => entries,
  openProject: async () => null,
  openRecent: async () => null,
  saveProject: async (_text: string, handle: SaveHandle) => handle,
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: '' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')

const schema = [{ name: 'Study Type', type: 'string' as const }]

function projectText(reviewers = 1): string {
  return JSON.stringify({
    version: 1,
    config: { schema, ...(reviewers > 1 ? { reviewers } : {}) },
    papers: [{ id: 'p1', title: 'One', authors: [], pdf: 'p1.pdf', annotations: {} }],
  })
}

const st = () => useStore.getState()
const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 }

describe('PDF marks — single-reviewer project', () => {
  beforeEach(() => {
    st().loadFromText(projectText(1), null, 'test.json')
    st().selectPaper('p1')
  })

  it('addHighlight creates a mark and sets dirty', () => {
    expect(st().dirty).toBe(false)
    const id = st().addHighlight(1, [rect])
    expect(id).not.toBeNull()
    expect(st().dirty).toBe(true)
    const marks = st().currentPdfMarks()
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ id, page: 1, rects: [rect], comment: '' })
  })

  it('defaults to the first palette color when none is given', () => {
    st().addHighlight(1, [rect])
    expect(st().currentPdfMarks()[0].color).toBe('#ffe066')
  })

  it('an explicit color overrides the default', () => {
    st().addHighlight(1, [rect], '#a5f3a5')
    expect(st().currentPdfMarks()[0].color).toBe('#a5f3a5')
  })

  it('refuses an empty rects array — nothing was actually selected', () => {
    const id = st().addHighlight(1, [])
    expect(id).toBeNull()
    expect(st().currentPdfMarks()).toEqual([])
  })

  it('setMarkComment attaches a note and bumps updatedAt', () => {
    const id = st().addHighlight(1, [rect])!
    const createdAt = st().currentPdfMarks()[0].updatedAt
    st().setMarkComment(id, 'worth citing')
    const mark = st().currentPdfMarks()[0]
    expect(mark.comment).toBe('worth citing')
    expect(mark.updatedAt >= createdAt).toBe(true)
  })

  it('setMarkComment("") clears a note back to a plain highlight', () => {
    const id = st().addHighlight(1, [rect])!
    st().setMarkComment(id, 'note')
    st().setMarkComment(id, '')
    expect(st().currentPdfMarks()[0].comment).toBe('')
  })

  it('setMarkColor recolors an existing highlight', () => {
    const id = st().addHighlight(1, [rect])!
    st().setMarkColor(id, '#d0bfff')
    expect(st().currentPdfMarks()[0].color).toBe('#d0bfff')
  })

  it('removeMark deletes it', () => {
    const id = st().addHighlight(1, [rect])!
    st().removeMark(id)
    expect(st().currentPdfMarks()).toEqual([])
  })

  it('setMarkComment/setMarkColor/removeMark on an unknown id do nothing and do not throw', () => {
    expect(() => st().setMarkComment('nope', 'x')).not.toThrow()
    expect(() => st().setMarkColor('nope', '#fff')).not.toThrow()
    expect(() => st().removeMark('nope')).not.toThrow()
    expect(st().currentPdfMarks()).toEqual([])
  })

  it('is not part of the annotation undo stack', () => {
    st().addHighlight(1, [rect])
    expect(st().past).toHaveLength(0)
  })
})

describe('PDF marks — field linking', () => {
  beforeEach(() => {
    st().loadFromText(projectText(1), null, 'test.json')
    st().selectPaper('p1')
  })

  it('linkMarkToField adds a LinkedField with the canonical path/label, sets dirty, bumps updatedAt', () => {
    const id = st().addHighlight(1, [rect])!
    const createdAt = st().currentPdfMarks()[0].updatedAt
    st().linkMarkToField(id, [], 'Study Type', 0)
    const mark = st().currentPdfMarks()[0]
    expect(mark.linkedFields).toEqual([{ path: 'Study Type', label: 'Study Type' }])
    expect(mark.updatedAt >= createdAt).toBe(true)
    expect(st().dirty).toBe(true)
  })

  it('linking the same field twice is a no-op, not a duplicate', () => {
    const id = st().addHighlight(1, [rect])!
    st().linkMarkToField(id, [], 'Study Type', 0)
    st().linkMarkToField(id, [], 'Study Type', 0)
    expect(st().currentPdfMarks()[0].linkedFields).toHaveLength(1)
  })

  it('a mark can be linked to more than one field', () => {
    const id = st().addHighlight(1, [rect])!
    st().linkMarkToField(id, [], 'Study Type', 0)
    st().linkMarkToField(id, [], 'Relevant', 0)
    expect(st().currentPdfMarks()[0].linkedFields?.map((l) => l.path).sort()).toEqual(['Relevant', 'Study Type'])
  })

  it('unlinkMarkFromField removes one entry and deletes the key once empty', () => {
    const id = st().addHighlight(1, [rect])!
    st().linkMarkToField(id, [], 'Study Type', 0)
    st().unlinkMarkFromField(id, 'Study Type')
    expect(st().currentPdfMarks()[0].linkedFields).toBeUndefined()
  })

  it('unlinkMarkFromField on an unknown mark id or path is a no-op', () => {
    const id = st().addHighlight(1, [rect])!
    st().linkMarkToField(id, [], 'Study Type', 0)
    expect(() => st().unlinkMarkFromField('nope', 'Study Type')).not.toThrow()
    expect(() => st().unlinkMarkFromField(id, 'Nonexistent')).not.toThrow()
    expect(st().currentPdfMarks()[0].linkedFields).toEqual([{ path: 'Study Type', label: 'Study Type' }])
  })

  it('linkMarkToField on an unknown mark id is a no-op', () => {
    expect(() => st().linkMarkToField('nope', [], 'Study Type', 0)).not.toThrow()
  })
})

describe('PDF marks — multi-reviewer scoping', () => {
  beforeEach(() => {
    st().loadFromText(projectText(2), null, 'test.json')
    st().selectPaper('p1')
  })

  it('refuses to add a highlight before a reviewer seat is picked', () => {
    expect(st().currentReviewer).toBeNull()
    const id = st().addHighlight(1, [rect])
    expect(id).toBeNull()
    expect(st().dirty).toBe(false)
  })

  it("each reviewer's highlights are their own", () => {
    st().selectReviewer('1')
    const id1 = st().addHighlight(1, [rect])!
    st().selectReviewer('2')
    expect(st().currentPdfMarks()).toEqual([])
    const id2 = st().addHighlight(1, [rect], '#a5d8ff')!

    st().selectReviewer('1')
    expect(st().currentPdfMarks().map((m) => m.id)).toEqual([id1])
    st().selectReviewer('2')
    expect(st().currentPdfMarks().map((m) => m.id)).toEqual([id2])
  })

  it('Consolidation has its own marks, separate from every reviewer', () => {
    st().selectReviewer('1')
    st().addHighlight(1, [rect])
    st().selectReviewer('consolidation')
    expect(st().currentPdfMarks()).toEqual([])
    st().addHighlight(1, [rect])
    expect(st().currentPdfMarks()).toHaveLength(1)
  })

  it('setMarkComment cannot reach another reviewer\'s mark', () => {
    st().selectReviewer('1')
    const id1 = st().addHighlight(1, [rect])!
    st().selectReviewer('2')
    st().setMarkComment(id1, 'sneaky')
    st().selectReviewer('1')
    expect(st().currentPdfMarks()[0].comment).toBe('')
  })
})
