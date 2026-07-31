import { describe, it, expect } from 'vitest'
import {
  parseMarks,
  parseReviewMarks,
  mergeMarksList,
  sortMarksForCycling,
  dedupeMarkGroups,
  orderMarksForLinking,
  type PdfMark,
} from './pdfMarks'

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
      {
        id: 'm2',
        page: 1,
        rects: [{ x: 0, y: 0, width: 1, height: 1 }],
        color: 'red',
        comment: '',
        createdAt: '',
        updatedAt: '',
        kind: 'highlight',
      },
    ])
  })

  it('keeps good entries and drops only the malformed ones from a mixed array', () => {
    const good = mark({ id: 'good' })
    expect(parseMarks([good, { id: 'bad' }, null, 42])).toEqual([good])
  })

  it('reads kind: "note", and defaults an absent or invalid kind to "highlight"', () => {
    expect(parseMarks([mark({ kind: 'note' })])[0].kind).toBe('note')
    expect(parseMarks([mark({ kind: undefined })])[0].kind).toBe('highlight')
    expect(parseMarks([{ ...mark(), kind: 'bogus' }])[0].kind).toBe('highlight')
  })

  it('reads a valid text, drops a non-string, and defaults to undefined when absent', () => {
    expect(parseMarks([mark({ text: 'the selected snippet' })])[0].text).toBe('the selected snippet')
    expect(parseMarks([{ ...mark(), text: 42 }])[0].text).toBeUndefined()
    expect(parseMarks([mark()])[0].text).toBeUndefined()
  })

  it('reads valid linkedFields, and defaults to undefined when absent or empty', () => {
    const linked = mark({ linkedFields: [{ path: 'Study Type', label: 'Study Type' }] })
    expect(parseMarks([linked])[0].linkedFields).toEqual([{ path: 'Study Type', label: 'Study Type' }])
    expect(parseMarks([mark()])[0].linkedFields).toBeUndefined()
    expect(parseMarks([mark({ linkedFields: [] })])[0].linkedFields).toBeUndefined()
  })

  it('drops a malformed linkedFields entry (missing path/label) but keeps the good ones', () => {
    const raw = {
      ...mark(),
      linkedFields: [{ path: 'Good', label: 'Good' }, { path: '' }, { label: 'no path' }, 'not an object'],
    }
    expect(parseMarks([raw])[0].linkedFields).toEqual([{ path: 'Good', label: 'Good' }])
  })

  it('defaults linkedFields to undefined when it is not an array', () => {
    expect(parseMarks([{ ...mark(), linkedFields: 'nope' }])[0].linkedFields).toBeUndefined()
  })

  it('reads a valid groupId, drops a non-string one, and defaults to undefined when absent', () => {
    expect(parseMarks([mark({ groupId: 'g1' })])[0].groupId).toBe('g1')
    expect(parseMarks([{ ...mark(), groupId: 42 }])[0].groupId).toBeUndefined()
    expect(parseMarks([{ ...mark(), groupId: '' }])[0].groupId).toBeUndefined()
    expect(parseMarks([mark()])[0].groupId).toBeUndefined()
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

  it('collapses a grouped pair to just its earliest-page fragment', () => {
    const frag1 = mark({ id: 'a', page: 1, groupId: 'g1' })
    const frag2 = mark({ id: 'b', page: 2, groupId: 'g1' })
    expect(sortMarksForCycling([frag2, frag1]).map((m) => m.id)).toEqual(['a'])
  })
})

describe('dedupeMarkGroups', () => {
  it('collapses marks sharing a groupId down to the first one seen', () => {
    const a = mark({ id: 'a', groupId: 'g1' })
    const b = mark({ id: 'b', groupId: 'g1' })
    const c = mark({ id: 'c' })
    expect(dedupeMarkGroups([a, b, c]).map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('keeps every mark when none share a groupId', () => {
    const marks = [mark({ id: 'a' }), mark({ id: 'b' }), mark({ id: 'c' })]
    expect(dedupeMarkGroups(marks)).toEqual(marks)
  })

  it('is [] for empty input', () => {
    expect(dedupeMarkGroups([])).toEqual([])
  })
})

describe('orderMarksForLinking', () => {
  it('pins the 3 most recently created marks first, most recent first', () => {
    const old = mark({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z', page: 5 })
    const r1 = mark({ id: 'r1', createdAt: '2026-01-02T00:00:00.000Z', page: 1 })
    const r2 = mark({ id: 'r2', createdAt: '2026-01-03T00:00:00.000Z', page: 2 })
    const r3 = mark({ id: 'r3', createdAt: '2026-01-04T00:00:00.000Z', page: 3 })
    expect(orderMarksForLinking([old, r1, r2, r3]).map((m) => m.id)).toEqual(['r3', 'r2', 'r1', 'old'])
  })

  it('does not repeat a recent mark in the page-ordered tail', () => {
    const recent = mark({ id: 'recent', createdAt: '2026-01-05T00:00:00.000Z', page: 1 })
    const other = mark({ id: 'other', createdAt: '2026-01-01T00:00:00.000Z', page: 2 })
    const ids = orderMarksForLinking([other, recent]).map((m) => m.id)
    expect(ids).toEqual(['recent', 'other'])
    expect(ids.filter((id) => id === 'recent')).toHaveLength(1)
  })

  it('with 4 or more marks, sorts everything past the pinned 3 by page', () => {
    const a = mark({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', page: 4 })
    const b = mark({ id: 'b', createdAt: '2026-01-02T00:00:00.000Z', page: 3 })
    const c = mark({ id: 'c', createdAt: '2026-01-03T00:00:00.000Z', page: 2 })
    const d = mark({ id: 'd', createdAt: '2026-01-04T00:00:00.000Z', page: 1 })
    // Recent 3, most-recent-first: d, c, b. Only "a" is left for the tail.
    expect(orderMarksForLinking([a, b, c, d]).map((m) => m.id)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('is the identity order for 3 or fewer marks (all of them are "recent")', () => {
    const a = mark({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', page: 3 })
    const b = mark({ id: 'b', createdAt: '2026-01-02T00:00:00.000Z', page: 1 })
    expect(orderMarksForLinking([a, b]).map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('does not mutate the input array', () => {
    const marks = [mark({ id: 'a', page: 2 }), mark({ id: 'b', page: 1 })]
    const copy = [...marks]
    orderMarksForLinking(marks)
    expect(marks).toEqual(copy)
  })

  it('is [] for empty input', () => {
    expect(orderMarksForLinking([])).toEqual([])
  })
})
