import { describe, it, expect } from 'vitest'
import { markVerticallyVisible } from './PdfViewer'
import type { PdfMark } from '../model/pdfMarks'

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

/** A page rendered at `top`, `height` pixels tall, in viewport coordinates —
 *  the shape `getBoundingClientRect()` returns, trimmed to what the function
 *  actually reads. */
function rect(top: number, height: number): DOMRect {
  return { top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }
}

describe('markVerticallyVisible', () => {
  it('is true when the mark sits well inside the scroll container', () => {
    // Page starts at viewport y=0, is 1000px tall; the mark's rect (y=0.2,
    // height=0.05) lands at 200–250px. A container spanning 0–800px covers it.
    expect(markVerticallyVisible(mark(), rect(0, 1000), rect(0, 800))).toBe(true)
  })

  it('is false when the mark is above the visible band', () => {
    // The page has scrolled far down: its top is now well above the
    // container's own top, so the mark (still near the page's own top) is
    // off-screen above.
    expect(markVerticallyVisible(mark(), rect(-500, 1000), rect(0, 800))).toBe(false)
  })

  it('is false when the mark is below the visible band', () => {
    expect(markVerticallyVisible(mark({ rects: [{ x: 0.1, y: 0.9, width: 0.3, height: 0.05 }] }), rect(0, 1000), rect(0, 800))).toBe(false)
  })

  it('is true right at the edges — a mark exactly flush with the container counts as visible', () => {
    // Mark spans the full 0..1000px page; container is exactly that tall too.
    expect(
      markVerticallyVisible(mark({ rects: [{ x: 0, y: 0, width: 1, height: 1 }] }), rect(0, 1000), rect(0, 1000)),
    ).toBe(true)
  })

  it('is false for a mark with no rects', () => {
    expect(markVerticallyVisible(mark({ rects: [] }), rect(0, 1000), rect(0, 800))).toBe(false)
  })

  it('only looks at the first rect — a highlight is judged by where it starts', () => {
    // A cross-page or multi-line highlight has several rects; visibility of
    // the mark as a whole is decided by its first one, matching what
    // `scrollToMark` centers on.
    const multi = mark({
      rects: [
        { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
        { x: 0.1, y: 0.9, width: 0.3, height: 0.05 },
      ],
    })
    expect(markVerticallyVisible(multi, rect(0, 1000), rect(0, 800))).toBe(true)
  })
})
