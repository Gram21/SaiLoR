import { describe, it, expect } from 'vitest'
import { detectEntryBox, detectNumericCitation, findNumericReference, type PreviewTextItem } from './refPreview'

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

  it('does not pad up into the previous entry of a tightly set list', () => {
    // Entry 13's first line starts 2 units below entry 12's last line.
    const items = [...line(100, 50, ['12.', 'Author,', 'A.:', 'Earlier', 'work']), ...line(112, 50, ['13.', 'Stacy,', 'W.:', 'Bias'])]
    const box = detectEntryBox(items, 50, 111, PAGE_H)
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(110) // below entry 12's bottom (y=110)
    expect(box!.y + box!.h).toBeGreaterThanOrEqual(122) // still covers entry 13
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

  it('returns null for a figure destination whose only nearby text is a label far to the right', () => {
    // hyperref's figure anchor: top-left of a figure; the diagram's "KB"
    // label is the only text in range, ~270 units right of destX.
    const items = [...referenceList(), ...line(400, 320, ['KB'], 15)]
    expect(detectEntryBox(items, 54, 390, PAGE_H)).toBeNull()
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

  it('pads the fitted entry by 4 units on every side', () => {
    expect(detectEntryBox(referenceList(), 50, 128, PAGE_H)).toEqual({ x: 46, y: 126, w: 223, h: 46 })
    expect(detectEntryBox(referenceList(), 150, 128, PAGE_H)).toEqual({ x: 46, y: 126, w: 223, h: 46 })
  })

  it('fits the same box when pdf.js delivers the items out of order', () => {
    expect(detectEntryBox(referenceList().reverse(), 50, 128, PAGE_H)).toEqual({ x: 46, y: 126, w: 223, h: 46 })
  })

  it('starts the box halfway into a gap smaller than the padding', () => {
    const items = [...line(100, 50, ['12.', 'Author,', 'A.:', 'Earlier', 'work']), ...line(112, 50, ['13.', 'Stacy,', 'W.:', 'Bias'])]
    expect(detectEntryBox(items, 50, 111, PAGE_H)).toEqual({ x: 46, y: 111, w: 140, h: 15 })
  })

  it('starts the box at the entry top when the previous line touches it', () => {
    const items = [...line(102, 50, ['12.', 'Author,', 'A.:', 'Earlier', 'work']), ...line(112, 50, ['13.', 'Stacy,', 'W.:', 'Bias'])]
    expect(detectEntryBox(items, 50, 111, PAGE_H)).toEqual({ x: 46, y: 112, w: 140, h: 14 })
  })

  it('keeps the full padding when the previous line ends exactly at the padding', () => {
    const items = [...line(98, 50, ['12.', 'Author,', 'A.:', 'Earlier', 'work']), ...line(112, 50, ['13.', 'Stacy,', 'W.:', 'Bias'])]
    expect(detectEntryBox(items, 50, 111, PAGE_H)).toEqual({ x: 46, y: 108, w: 140, h: 18 })
  })

  it('ignores text above the entry that does not overlap it horizontally', () => {
    const items = [
      { str: 'left', x: 20, y: 100, w: 30, h: 10 }, // ends exactly at the entry's left edge
      { str: 'right', x: 182, y: 100, w: 30, h: 10 }, // starts exactly at the entry's right edge
      ...line(112, 50, ['13.', 'Stacy,', 'W.:', 'Bias']),
      ...line(300, 50, ['x', 'y']),
    ]
    expect(detectEntryBox(items, 50, 111, PAGE_H)).toEqual({ x: 46, y: 108, w: 140, h: 18 })
  })

  it('counts only non-blank items towards the sparse-page threshold', () => {
    const blanks = [' ', '', '  '].map((str, i) => ({ str, x: 300 + i * 20, y: 100, w: 10, h: 10 }))
    expect(detectEntryBox([...line(100, 50, ['a', 'b', 'c', 'd', 'e', 'f', 'g']), ...blanks], 50, 98, PAGE_H)).toBeNull()
    expect(detectEntryBox(line(100, 50, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), 50, 98, PAGE_H)).toEqual({
      x: 46,
      y: 96,
      w: 276,
      h: 18,
    })
  })

  it('anchors on the nearest line without a destination x', () => {
    expect(detectEntryBox(referenceList(), null, 128, PAGE_H)).toEqual({ x: 46, y: 126, w: 223, h: 46 })
  })

  it('searches for the anchor line from 5 above to 30 below the destination', () => {
    expect(detectEntryBox(referenceList(), 50, 135, PAGE_H)).toEqual({ x: 46, y: 126, w: 223, h: 46 })
    expect(detectEntryBox(referenceList(), 50, 142, PAGE_H)).toEqual({ x: 46, y: 168, w: 208, h: 32 })
    expect(detectEntryBox(referenceList(), 50, 141, PAGE_H)).toBeNull()
  })

  it('prefers the upper line when two lines are equally near the destination', () => {
    const items = [...line(100, 50, ['Alpha', 'beta', 'gamma', 'delta']), ...line(108, 50, ['epsilon', 'zeta', 'eta', 'theta'])]
    expect(detectEntryBox(items, 50, 104, PAGE_H)).toEqual({ x: 46, y: 96, w: 140, h: 26 })
  })

  it('anchors only on text from 15 units left to 12 units right of destX', () => {
    // Line 144 starts exactly 12 units right of destX 53.
    expect(detectEntryBox(referenceList(), 53, 142, PAGE_H)).toEqual({ x: 61, y: 140, w: 208, h: 18 })
    // Lines 100 and 130 end exactly 15 units left of destX 265 or earlier.
    expect(detectEntryBox(referenceList(), 265, 100, PAGE_H)).toBeNull()
    // A "[1]" label that ends 5 units right of destX still anchors.
    const items = [
      { str: '[1]', x: 50, y: 130, w: 25, h: 10 },
      ...line(130, 85, ['Some', 'author', 'title']),
      ...line(144, 85, ['more', 'text', 'here', 'now']),
    ]
    expect(detectEntryBox(items, 70, 128, PAGE_H)).toEqual({ x: 46, y: 126, w: 175, h: 32 })
  })

  it('finds the entry start even when its label sits slightly lower than its line', () => {
    const items = [
      { str: '13.', x: 50, y: 133, w: 20, h: 10 }, // 3 units lower: still the same line
      ...line(130, 74, ['Stacy,', 'W.:', 'Cognitive'], 20),
      ...line(144, 65, ['bias.', 'Commun.', 'ACM'], 20),
      ...line(158, 50, ['14.', 'Tang,', 'A.:', 'Biased?'], 20),
      ...line(130, 340, ['22.', 'Other,', 'B.:', 'Unrelated'], 20),
      ...line(144, 355, ['right-column', 'entry', 'text'], 20),
    ]
    expect(detectEntryBox(items, 50, 128, PAGE_H)).toEqual({ x: 46, y: 126, w: 100, h: 32 })
  })

  it('fits a right-column entry and skips lines with only left-column text', () => {
    const items = [
      ...line(130, 340, ['22.', 'Other,', 'B.:', 'Unrelated'], 20),
      ...line(144, 355, ['right-column', 'entry', 'text'], 20),
      ...line(137, 50, ['left', 'column', 'body', 'text'], 20),
      ...line(151, 50, ['more', 'left', 'column', 'text'], 20),
    ]
    expect(detectEntryBox(items, 340, 128, PAGE_H)).toEqual({ x: 336, y: 126, w: 100, h: 32 })
  })

  it('fits a right-column entry when both columns share its lines', () => {
    const items = [
      ...line(130, 50, ['13.', 'Stacy,', 'W.:', 'Cognitive'], 20),
      ...line(144, 65, ['bias.', 'Commun.', 'ACM'], 20),
      ...line(158, 50, ['14.', 'Tang,', 'A.:', 'Biased?'], 20),
      ...line(130, 340, ['22.', 'Other,', 'B.:', 'Unrelated'], 20),
      ...line(144, 355, ['right-column', 'entry', 'text'], 20),
    ]
    expect(detectEntryBox(items, 340, 128, PAGE_H)).toEqual({ x: 336, y: 126, w: 100, h: 32 })
  })

  it('joins items at most 12 units apart into one run, from either side of the destination', () => {
    const items = [
      { str: '[1]', x: 50, y: 130, w: 25, h: 10 },
      ...line(130, 87, ['Some', 'author', 'title']), // 12 units right of the label
      ...line(144, 87, ['more']),
      ...line(300, 50, ['x', 'y', 'z']),
    ]
    expect(detectEntryBox(items, 50, 128, PAGE_H)).toEqual({ x: 46, y: 126, w: 143, h: 32 })
    expect(detectEntryBox(items, 87, 128, PAGE_H)).toEqual({ x: 46, y: 126, w: 143, h: 32 })
  })

  it('anchors on the lower line when it is nearer the destination', () => {
    const items = [...line(100, 50, ['Alpha', 'beta', 'gamma', 'delta']), ...line(108, 50, ['epsilon', 'zeta', 'eta', 'theta'])]
    expect(detectEntryBox(items, 50, 105, PAGE_H)).toEqual({ x: 46, y: 104, w: 140, h: 18 })
  })

  it('keeps a short continuation line that ends just right of the margin', () => {
    const items = [...line(100, 50, ['Alpha', 'beta', 'gamma', 'delta']), { str: 'of', x: 50, y: 114, w: 8, h: 10 }, ...line(300, 50, ['x', 'y', 'z'])]
    expect(detectEntryBox(items, 50, 98, PAGE_H)).toEqual({ x: 46, y: 96, w: 140, h: 32 })
  })

  it('ignores leading spaces when checking whether a margin line starts a new entry', () => {
    const items = [...line(100, 50, ['Alpha', 'beta', 'gamma', 'delta']), ...line(114, 50, [' 14.', 'Next']), ...line(300, 50, ['x', 'y'])]
    expect(detectEntryBox(items, 50, 98, PAGE_H)).toEqual({ x: 46, y: 96, w: 140, h: 18 })
  })

  it('stops the top halfway into the gap for text above that overlaps the entry from the left', () => {
    const items = [{ str: 'tail', x: 40, y: 100, w: 30, h: 10 }, ...line(112, 50, ['13.', 'Stacy,', 'W.:', 'Bias']), ...line(300, 50, ['x', 'y', 'z'])]
    expect(detectEntryBox(items, 50, 111, PAGE_H)).toEqual({ x: 46, y: 111, w: 140, h: 15 })
  })

  it('skips lines with only right-column text when fitting a left-column entry', () => {
    const items = [
      ...line(130, 50, ['13.', 'Stacy,', 'W.:', 'Cognitive'], 20),
      ...line(144, 65, ['bias.', 'Commun.', 'ACM'], 20),
      ...line(137, 340, ['right', 'column', 'body', 'text'], 20),
    ]
    expect(detectEntryBox(items, 50, 128, PAGE_H)).toEqual({ x: 46, y: 126, w: 100, h: 32 })
  })

  it('keeps continuation lines that start up to two gutters right of the widest line so far', () => {
    const items = [
      ...line(130, 50, ['13.', 'Ab']), // right edge 114
      ...line(144, 138, ['cd']), // starts exactly 24 right of it, ends at 168
      ...line(158, 150, ['ef']), // starts past 114 + 24 but within 168 + 24
      ...line(300, 50, ['x', 'y', 'z', 'w', 'v']),
    ]
    expect(detectEntryBox(items, 50, 128, PAGE_H)).toEqual({ x: 46, y: 126, w: 138, h: 46 })
  })

  it('scales the paragraph-gap threshold with the tallest glyph of the first line', () => {
    const tall = (y: number, x: number, words: string[]) => line(y, x, words).map((it) => ({ ...it, h: 20 }))
    const items = [...tall(100, 50, ['Alpha', 'beta', 'gamma']), ...tall(130, 65, ['delta', 'eps', 'zeta']), ...line(300, 50, ['x', 'y'])]
    expect(detectEntryBox(items, 50, 98, PAGE_H)).toEqual({ x: 46, y: 96, w: 121, h: 58 })
  })

  it('treats a gap of exactly 1.8 line heights as the same entry', () => {
    const items = [...line(100, 50, ['Alpha', 'beta', 'gamma', 'delta']), ...line(118, 50, ['epsilon', 'zeta', 'eta', 'theta'])]
    expect(detectEntryBox(items, 50, 98, PAGE_H)).toEqual({ x: 46, y: 96, w: 140, h: 36 })
  })

  it('ends a flush-left entry only at a line starting with a number or bracket', () => {
    const items = [
      ...line(100, 50, ['Kruchten,', 'P.:', 'The', 'view']),
      ...line(114, 50, ['model', 'of', 'software']),
      ...line(128, 50, ['archi', 'in', '2019']),
      ...line(142, 50, ['13.', 'Next']),
    ]
    expect(detectEntryBox(items, 50, 98, PAGE_H)).toEqual({ x: 46, y: 96, w: 140, h: 46 })
  })

  it('ends an entry at a numbered line that starts within 3 units of the margin', () => {
    const items = [...line(100, 50, ['Alpha', 'beta', 'gamma', 'delta']), ...line(114, 53, ['2019', 'work']), ...line(300, 50, ['x', 'y'])]
    expect(detectEntryBox(items, 50, 98, PAGE_H)).toEqual({ x: 46, y: 96, w: 140, h: 18 })
  })

  it('treats a continuation 5 units right of the margin as a hanging indent', () => {
    const entry = (indentX: number) => [
      ...line(100, 50, ['Smith,', 'J.:', 'Title', 'here']),
      ...line(114, indentX, ['cont', 'inued']),
      ...line(128, 50, ['Tang,', 'A.:', 'Other']),
    ]
    // Hanging indent: the next margin line starts a new entry.
    expect(detectEntryBox(entry(55), 50, 98, PAGE_H)).toEqual({ x: 46, y: 96, w: 140, h: 32 })
    // 4 units is no indent: the margin line still continues the entry.
    expect(detectEntryBox(entry(54), 50, 98, PAGE_H)).toEqual({ x: 46, y: 96, w: 140, h: 46 })
  })

  it('includes a line whose bottom reaches exactly a quarter page below the anchor', () => {
    const items: PreviewTextItem[] = []
    for (let i = 0; i < 25; i++) items.push(...line(100 + i * 10, 50, ['body', 'text', 'line']))
    // Line 19 (y 290) ends 200 = 800 / 4 below the anchor's top; line 20 does not fit.
    expect(detectEntryBox(items, 50, 98, PAGE_H)).toEqual({ x: 46, y: 96, w: 106, h: 208 })
  })
})

describe('detectNumericCitation', () => {
  const s = 'approaches [7], [8], [2], making it'
  it('reads the number under the cursor', () => {
    expect(detectNumericCitation(s, s.indexOf('7'))).toBe(7)
    expect(detectNumericCitation(s, s.indexOf('[8'))).toBe(8)
    expect(detectNumericCitation(s, s.indexOf('2]') + 1)).toBe(2) // on "]"
  })
  it('picks the nearest token in a list or range', () => {
    const t = 'see [3-5, 12] here'
    expect(detectNumericCitation(t, t.indexOf('3'))).toBe(3)
    expect(detectNumericCitation(t, t.indexOf('5'))).toBe(5)
    expect(detectNumericCitation(t, t.indexOf('12') + 1)).toBe(12)
  })
  it('ignores text outside brackets and non-numeric brackets', () => {
    expect(detectNumericCitation(s, s.indexOf('making'))).toBeNull()
    expect(detectNumericCitation(s, s.indexOf(' [8'))).toBeNull() // the space between citations
    const t = 'array [i] access'
    expect(detectNumericCitation(t, t.indexOf('i]'))).toBeNull()
  })
  it('reads a citation at the very start of the text', () => {
    expect(detectNumericCitation('[3] see', 1)).toBe(3)
  })
  it('needs an opening bracket and a closing bracket right after the list', () => {
    expect(detectNumericCitation('1 2]', 2)).toBeNull()
    expect(detectNumericCitation('3] x', 0)).toBeNull()
    expect(detectNumericCitation('[3a]', 1)).toBeNull()
  })
  it('measures distance to the nearest edge of multi-digit tokens', () => {
    const t = '[10, 20]'
    expect(detectNumericCitation(t, 0)).toBe(10) // on "["
    expect(detectNumericCitation(t, 2)).toBe(10)
    expect(detectNumericCitation(t, 3)).toBe(10) // on ","
    expect(detectNumericCitation(t, 4)).toBe(20) // on " "
    expect(detectNumericCitation(t, 7)).toBe(20) // on "]"
  })
  it('prefers the earlier token on a distance tie', () => {
    expect(detectNumericCitation('[1,3]', 2)).toBe(1)
  })
  it('accepts reference 1 but never 0', () => {
    expect(detectNumericCitation('[1]', 1)).toBe(1)
    expect(detectNumericCitation('[0, 5]', 1)).toBe(5)
    expect(detectNumericCitation('[0]', 1)).toBeNull()
  })
})

describe('findNumericReference', () => {
  it('finds a label at the column edge, not body text starting a line', () => {
    const items = [
      ...line(100, 50, ['[4].', 'Yet', 'these']), // body text wrapping to a line start
      ...line(300, 50, ['[3]']),
      ...line(300, 72, ['A.', 'Author,', 'Title']),
      ...line(320, 50, ['[4]']),
      ...line(320, 72, ['B.', 'Writer,', 'Other']),
    ]
    expect(findNumericReference(items, 4)).toEqual({ x: 50, y: 320 })
    expect(findNumericReference(items, 5)).toBeNull()
  })
  it('rejects a label with text right before it on its line', () => {
    const items = [...line(100, 50, ['as', 'shown', 'in']), { str: '[4]', x: 152, y: 100, w: 15, h: 10 }]
    expect(findNumericReference(items, 4)).toBeNull()
  })
  it('does not match [1] inside [12]', () => {
    expect(findNumericReference(line(100, 50, ['[12]']), 1)).toBeNull()
  })
  it('allows text that ends exactly 12 units left of the label', () => {
    const label = { str: '[4]', x: 50, y: 100, w: 15, h: 10 }
    expect(findNumericReference([{ str: 'gutter', x: 18, y: 100, w: 20, h: 10 }, label], 4)).toEqual({ x: 50, y: 100 })
    expect(findNumericReference([{ str: 'gutter', x: 19, y: 100, w: 20, h: 10 }, label], 4)).toBeNull()
  })
  it('ignores blank items, items at the same x and text on other lines', () => {
    const label = { str: '[4]', x: 50, y: 100, w: 15, h: 10 }
    expect(findNumericReference([{ str: ' ', x: 30, y: 100, w: 15, h: 10 }, label], 4)).toEqual({ x: 50, y: 100 })
    expect(findNumericReference([{ str: 'sup', x: 50, y: 100, w: 5, h: 10 }, label], 4)).toEqual({ x: 50, y: 100 })
    expect(findNumericReference([{ str: 'far', x: 30, y: 200, w: 15, h: 10 }, label], 4)).toEqual({ x: 50, y: 100 })
  })
  it('counts text within the label height (at least 8 units) as the same line', () => {
    const label = { str: '[4]', x: 50, y: 100, w: 15, h: 10 }
    expect(findNumericReference([{ str: 'see', x: 30, y: 110, w: 15, h: 10 }, label], 4)).toBeNull()
    expect(findNumericReference([{ str: 'see', x: 30, y: 111, w: 15, h: 10 }, label], 4)).toEqual({ x: 50, y: 100 })
    const tallLabel = { ...label, h: 20 }
    expect(findNumericReference([{ str: 'see', x: 20, y: 115, w: 25, h: 10 }, tallLabel], 4)).toBeNull()
  })
})
