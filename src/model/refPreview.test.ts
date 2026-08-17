import { describe, it, expect } from 'vitest'
import { detectEntryBox, type PreviewTextItem } from './refPreview'

/** One text line as pdf.js would deliver it: a handful of items laid out
 *  left-to-right from `x`, each ~10 units tall. */
function line(y: number, x: number, words: string[], wordW = 30): PreviewTextItem[] {
  return words.map((str, i) => ({ str, x: x + i * (wordW + 4), y, w: wordW, h: 10 }))
}

const PAGE_H = 800

/** A single-column numbered reference list: entries at x=50, hanging-indent
 *  continuations at x=65, 14 units of leading. */
function referenceList(): PreviewTextItem[] {
  return [
    ...line(100, 50, ['12.', 'Author,', 'A.:', 'Earlier', 'work']),
    ...line(130, 50, ['13.', 'Stacy,', 'W.,', 'Macmillan,', 'J.:', 'Cognitive']),
    ...line(144, 65, ['bias', 'in', 'software', 'engineering.', 'Commun.', 'ACM']),
    ...line(158, 65, ['38(6),', '57-63', '(1995)']),
    ...line(172, 50, ['14.', 'Tang,', 'A.:', 'Software', 'designers,', 'are']),
    ...line(186, 65, ['you', 'biased?', 'In:', 'Proceedings']),
  ]
}

describe('detectEntryBox', () => {
  it('fits a numbered hanging-indent entry: all its lines, not the next entry', () => {
    // Link to entry 13: dest points at its first line.
    const box = detectEntryBox(referenceList(), 50, 128, PAGE_H)
    expect(box).not.toBeNull()
    // Covers lines at y=130..158 (entry 13 with both continuations)…
    expect(box!.y).toBeLessThanOrEqual(130)
    expect(box!.y + box!.h).toBeGreaterThanOrEqual(168)
    // …but stops before entry 14's text (y=172; its own padding may touch it)
    // and never reaches entry 12 (y=100).
    expect(box!.y + box!.h).toBeLessThanOrEqual(172)
    expect(box!.y).toBeGreaterThan(110)
  })

  it('recovers the entry start when destX lands mid-line', () => {
    // A poorly-authored link whose destX points at the middle of the line.
    const box = detectEntryBox(referenceList(), 150, 128, PAGE_H)
    expect(box).not.toBeNull()
    expect(box!.x).toBeLessThanOrEqual(50) // walked left to the "13." label
  })

  it('stops at a paragraph gap when entries are flush-left', () => {
    const items = [
      ...line(100, 50, ['Kruchten,', 'P.:', 'The', '4+1', 'view', 'model']),
      ...line(114, 50, ['of', 'architecture.', 'IEEE', 'Software']),
      // 30 units of whitespace — a paragraph break, then unrelated text.
      ...line(158, 50, ['Some', 'following', 'paragraph', 'text', 'here']),
    ]
    const box = detectEntryBox(items, 50, 98, PAGE_H)
    expect(box).not.toBeNull()
    expect(box!.y + box!.h).toBeGreaterThanOrEqual(124)
    expect(box!.y + box!.h).toBeLessThan(158)
  })

  it('stays inside its own column of a two-column layout', () => {
    // Same y-range in both columns; the gutter (300..340) is wider than
    // word spacing. Entry hovered is in the LEFT column.
    const items = [
      ...line(130, 50, ['13.', 'Stacy,', 'W.:', 'Cognitive'], 20),
      ...line(144, 65, ['bias.', 'Commun.', 'ACM'], 20),
      ...line(158, 50, ['14.', 'Tang,', 'A.:', 'Biased?'], 20),
      ...line(130, 340, ['22.', 'Other,', 'B.:', 'Unrelated'], 20),
      ...line(144, 355, ['right-column', 'entry', 'text'], 20),
    ]
    const box = detectEntryBox(items, 50, 128, PAGE_H)
    expect(box).not.toBeNull()
    expect(box!.x + box!.w).toBeLessThan(340) // never crosses the gutter
  })

  it('returns null for a sparse (image-only) page', () => {
    expect(detectEntryBox(line(100, 50, ['Lone', 'caption']), 50, 98, PAGE_H)).toBeNull()
  })

  it('returns null when the destination points at empty space', () => {
    expect(detectEntryBox(referenceList(), 50, 400, PAGE_H)).toBeNull()
  })

  it('caps the box height on a page with no entry structure at all', () => {
    // 60 consecutive flush-left lines with uniform leading — nothing ever
    // returns to a *different* margin and there is no gap; the height cap
    // must stop the walk.
    const items: PreviewTextItem[] = []
    for (let i = 0; i < 60; i++) items.push(...line(100 + i * 14, 50, ['body', 'text', 'line', String(i)]))
    const box = detectEntryBox(items, 50, 98, PAGE_H)
    expect(box).not.toBeNull()
    expect(box!.h).toBeLessThanOrEqual(PAGE_H * 0.25 + 20)
  })
})
