import { describe, it, expect } from 'vitest'
import { destinationPoint, markVerticallyVisible, dedupeOverlappingRects } from './PdfViewer'
import type { PdfMark, MarkRect } from '../model/pdfMarks'

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

describe('destinationPoint', () => {
  // dest[0] is the target page Ref — destinationPoint never reads it.
  const ref = { num: 42, gen: 0 }

  it('reads x and y from an XYZ destination', () => {
    expect(destinationPoint([ref, { name: 'XYZ' }, 72, 680, 0])).toEqual({ x: 72, y: 680 })
  })

  it('treats an XYZ null coordinate ("keep current") as unspecified', () => {
    expect(destinationPoint([ref, { name: 'XYZ' }, null, 680, null])).toEqual({ x: null, y: 680 })
  })

  it('reads only y from FitH/FitBH', () => {
    expect(destinationPoint([ref, { name: 'FitH' }, 680])).toEqual({ x: null, y: 680 })
    expect(destinationPoint([ref, { name: 'FitBH' }, 680])).toEqual({ x: null, y: 680 })
  })

  it('reads only x from FitV/FitBV', () => {
    expect(destinationPoint([ref, { name: 'FitV' }, 72])).toEqual({ x: 72, y: null })
    expect(destinationPoint([ref, { name: 'FitBV' }, 72])).toEqual({ x: 72, y: null })
  })

  it('anchors a FitR at its rectangle\'s top-left', () => {
    expect(destinationPoint([ref, { name: 'FitR' }, 72, 600, 300, 680])).toEqual({ x: 72, y: 680 })
  })

  it('is fully unspecified for whole-page fits and malformed kinds', () => {
    expect(destinationPoint([ref, { name: 'Fit' }])).toEqual({ x: null, y: null })
    expect(destinationPoint([ref, { name: 'FitB' }])).toEqual({ x: null, y: null })
    expect(destinationPoint([ref])).toEqual({ x: null, y: null })
    expect(destinationPoint([ref, null, 72, 680])).toEqual({ x: null, y: null })
  })
})

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

describe('dedupeOverlappingRects', () => {
  const r = (x: number, y: number, width: number, height: number): MarkRect => ({ x, y, width, height })

  it('leaves distinct, non-overlapping rects alone', () => {
    // Three separate lines of a multi-line highlight.
    const rects = [r(0.1, 0.1, 0.3, 0.05), r(0.05, 0.2, 0.5, 0.05), r(0.05, 0.3, 0.2, 0.05)]
    expect(dedupeOverlappingRects(rects)).toEqual(rects)
  })

  it('leaves side-by-side rects on the same line alone — pdf.js gives each text run its own span', () => {
    const rects = [r(0.1, 0.2, 0.2, 0.05), r(0.3, 0.2, 0.2, 0.05)]
    expect(dedupeOverlappingRects(rects)).toEqual(rects)
  })

  it('folds a near-duplicate middle-line rect into one, the reported "marked twice" bug', () => {
    // Range.getClientRects() reporting the same fully-covered line as two
    // near-identical, heavily-overlapping rects — the actual bug report.
    const rects = [r(0.05, 0.2, 0.5, 0.05), r(0.05, 0.201, 0.5, 0.05)]
    const out = dedupeOverlappingRects(rects)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ x: 0.05, width: 0.5 })
  })

  it('unions two overlapping duplicates rather than arbitrarily discarding one', () => {
    // Slightly different extents (rounding) — the merged rect must cover both.
    const rects = [r(0.05, 0.2, 0.4, 0.05), r(0.1, 0.2, 0.45, 0.05)]
    const out = dedupeOverlappingRects(rects)
    expect(out).toHaveLength(1)
    expect(out[0].x).toBeCloseTo(0.05)
    expect(out[0].x + out[0].width).toBeCloseTo(0.55)
  })
})
