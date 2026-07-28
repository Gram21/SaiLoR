import { describe, it, expect } from 'vitest'
import { parseMarks, parseReviewMarks, mergeMarksList, sortMarksForCycling, type PdfMark } from './pdfMarks'

function mark(overrides: Partial<PdfMark> = {}): PdfMark {
  return {
    id: 'm1',
    page: 1,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
    color: '#ffe066',
    comment: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'highlight',
    ...overrides,
  }
}

describe('parseMarks', () => {
  it('accepts a well-formed mark', () => {
    expect(parseMarks([mark()])).toEqual([mark()])
  })

  it('is [] for non-array input', () => {
    expect(parseMarks(undefined)).toEqual([])
    expect(parseMarks(null)).toEqual([])
    expect(parseMarks({})).toEqual([])
  })

  it('drops an entry missing an id', () => {
    const { id: _id, ...rest } = mark()
    expect(parseMarks([rest])).toEqual([])
  })

  it('drops an entry with a non-integer or out-of-range page', () => {
    expect(parseMarks([mark({ page: 0 })])).toEqual([])
    expect(parseMarks([mark({ page: 1.5 })])).toEqual([])
    expect(parseMarks([mark({ page: -1 })])).toEqual([])
  })

  it('drops an entry with no rects, or a malformed rect', () => {
    expect(parseMarks([mark({ rects: [] })])).toEqual([])
    expect(parseMarks([mark({ rects: [{ x: 0, y: 0, width: 0 } as never] })])).toEqual([])
  })

  it('drops an entry missing a color', () => {
    expect(parseMarks([mark({ color: '' })])).toEqual([])
  })

  it('defaults comment/createdAt/updatedAt to empty strings when absent or wrong type', () => {
    const raw = { id: 'm2', page: 1, rects: [{ x: 0, y: 0, width: 1, height: 1 }], color: 'red' }
    expect(parseMarks([raw])).toEqual([
      { id: 'm2', page: 1, rects: [{ x: 0, y: 0, width: 1, height: 1 }], color: 'red', comment: '', createdAt: '', updatedAt: '', kind: 'highlight' },
    ])
  })

  it('defaults kind to "highlight" when absent (legacy marks) or not "note"', () => {
    const raw = { id: 'm3', page: 1, rects: [{ x: 0, y: 0, width: 1, height: 1 }], color: 'red' }
    expect(parseMarks([raw])[0].kind).toBe('highlight')
    expect(parseMarks([{ ...raw, kind: 'bogus' }])[0].kind).toBe('highlight')
    expect(parseMarks([{ ...raw, kind: 'note' }])[0].kind).toBe('note')
  })

  it('keeps good entries and drops only the malformed ones from a mixed array', () => {
    const good = mark({ id: 'good' })
    expect(parseMarks([good, { id: 'bad' }, null, 42])).toEqual([good])
  })
})

describe('parseReviewMarks', () => {
  it('keeps only reviewer-number-shaped keys with at least one mark', () => {
    const m = mark()
    expect(parseReviewMarks({ '1': [m], '2': [], notANumber: [m], '0': [m] })).toEqual({ '1': [m] })
  })

  it('is {} for non-object input', () => {
    expect(parseReviewMarks(undefined)).toEqual({})
    expect(parseReviewMarks([])).toEqual({})
  })
})

describe('mergeMarksList', () => {
  it('unions marks present on only one side', () => {
    const a = mark({ id: 'a' })
    const b = mark({ id: 'b' })
    const merged = mergeMarksList([a], [b])
    expect(merged).toHaveLength(2)
    expect(merged.map((m) => m.id).sort()).toEqual(['a', 'b'])
  })

  it('keeps ours when both sides have the same id and theirs has no later updatedAt', () => {
    const ours = mark({ id: 'x', comment: 'mine', updatedAt: '2026-01-02T00:00:00.000Z' })
    const theirs = mark({ id: 'x', comment: 'theirs', updatedAt: '2026-01-01T00:00:00.000Z' })
    expect(mergeMarksList([ours], [theirs])).toEqual([ours])
  })

  it('takes theirs when it was updated more recently', () => {
    const ours = mark({ id: 'x', comment: 'mine', updatedAt: '2026-01-01T00:00:00.000Z' })
    const theirs = mark({ id: 'x', comment: 'theirs', updatedAt: '2026-01-02T00:00:00.000Z' })
    expect(mergeMarksList([ours], [theirs])).toEqual([theirs])
  })

  it('never drops a mark — the union is at least as large as either side', () => {
    const merged = mergeMarksList([mark({ id: 'a' }), mark({ id: 'b' })], [mark({ id: 'b' }), mark({ id: 'c' })])
    expect(merged.map((m) => m.id).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('sortMarksForCycling', () => {
  it('is [] for empty input', () => {
    expect(sortMarksForCycling([])).toEqual([])
  })

  it('orders by page ascending', () => {
    const a = mark({ id: 'a', page: 3 })
    const b = mark({ id: 'b', page: 1 })
    const c = mark({ id: 'c', page: 2 })
    expect(sortMarksForCycling([a, b, c]).map((m) => m.id)).toEqual(['b', 'c', 'a'])
  })

  it('within a page, orders by the first rect\'s y ascending', () => {
    const top = mark({ id: 'top', rects: [{ x: 0, y: 0.1, width: 0.1, height: 0.1 }] })
    const bottom = mark({ id: 'bottom', rects: [{ x: 0, y: 0.8, width: 0.1, height: 0.1 }] })
    expect(sortMarksForCycling([bottom, top]).map((m) => m.id)).toEqual(['top', 'bottom'])
  })

  it('is stable for exact ties', () => {
    const a = mark({ id: 'a' })
    const b = mark({ id: 'b' })
    expect(sortMarksForCycling([a, b]).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('does not mutate the input array', () => {
    const marks = [mark({ id: 'a', page: 2 }), mark({ id: 'b', page: 1 })]
    const copy = [...marks]
    sortMarksForCycling(marks)
    expect(marks).toEqual(copy)
  })
})
