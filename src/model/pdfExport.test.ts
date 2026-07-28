import { describe, it, expect } from 'vitest'
import { rectToPdfPoints, rectToQuadPoints, annotatedFileName } from './pdfExport'
import type { MarkRect } from './pdfMarks'

describe('rectToPdfPoints', () => {
  it('maps a full-page rect to the full page, in PDF points', () => {
    const rect: MarkRect = { x: 0, y: 0, width: 1, height: 1 }
    expect(rectToPdfPoints(rect, 600, 800)).toEqual({ x: 0, y: 0, width: 600, height: 800 })
  })

  it('maps a top-right rect to the top-right of the page', () => {
    // Right half width, top 10% height.
    const rect: MarkRect = { x: 0.5, y: 0, width: 0.5, height: 0.1 }
    const got = rectToPdfPoints(rect, 600, 800)
    expect(got.x).toBe(300)
    expect(got.width).toBe(300)
    expect(got.height).toBe(80)
    // Bottom edge of a rect pinned to the very top, 80pt tall, on an 800pt page.
    expect(got.y).toBe(720)
  })

  it('maps a bottom-left rect to the bottom-left of the page', () => {
    const rect: MarkRect = { x: 0, y: 0.9, width: 0.2, height: 0.1 }
    const got = rectToPdfPoints(rect, 600, 800)
    expect(got.x).toBe(0)
    expect(got.width).toBe(120)
    expect(got.height).toBe(80)
    expect(got.y).toBe(0)
  })
})

describe('rectToQuadPoints', () => {
  it('returns 8 numbers ordered TL, TR, BL, BR', () => {
    const rect: MarkRect = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 }
    const quad = rectToQuadPoints(rect, 1000, 2000)
    // x=100, width=300 -> left=100, right=400
    // y=0.2*2000=400, height=0.05*2000=100 -> bottom=2000-400-100=1500, top=1600
    expect(quad).toEqual([
      100, 1600, // top-left
      400, 1600, // top-right
      100, 1500, // bottom-left
      400, 1500, // bottom-right
    ])
  })

  it('has length 8 for any rect', () => {
    const rect: MarkRect = { x: 0, y: 0, width: 1, height: 1 }
    expect(rectToQuadPoints(rect, 600, 800)).toHaveLength(8)
  })
})

describe('annotatedFileName', () => {
  it('inserts -annotated before .pdf', () => {
    expect(annotatedFileName('paper.pdf')).toBe('paper-annotated.pdf')
  })

  it('is case-insensitive about the .pdf extension', () => {
    expect(annotatedFileName('paper.PDF')).toBe('paper-annotated.pdf')
  })

  it('appends .pdf when the original has no extension', () => {
    expect(annotatedFileName('paper')).toBe('paper-annotated.pdf')
  })

  it('does not double-suffix a name already ending in -annotated', () => {
    expect(annotatedFileName('paper-annotated.pdf')).toBe('paper-annotated.pdf')
  })

  it('handles a name with dots in the middle', () => {
    expect(annotatedFileName('my.paper.v2.pdf')).toBe('my.paper.v2-annotated.pdf')
  })
})
