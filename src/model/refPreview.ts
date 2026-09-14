/**
 * Fitting the reference-hover preview box (PdfViewer's internal-link hover)
 * to the destination's own entry — a compact port of the essential steps of
 * SumatraPDF's DetectEntryBox: anchor on the text line nearest the link
 * destination, expand it into a gap-bounded line run (gutters between columns
 * are wider than spacing within a line, so the run never leaves its column),
 * then walk following lines until the next entry starts (a line back at the
 * entry's left margin) or a paragraph gap. Works on pdf.js text items in
 * viewport coordinates (y grows downward), so it is pure and unit-testable.
 *
 * ponytail: no equation-box detection and no cross-column continuation
 * stitching (SumatraPDF has both) — add if entries cut at column breaks or
 * equation refs turn out to matter.
 */

/** One pdf.js text item, in scale-1 viewport coordinates: `x`/`y` is the
 *  item's top-left, `w`/`h` its rendered extent. */
export type PreviewTextItem = { str: string; x: number; y: number; w: number; h: number }

export type EntryBox = { x: number; y: number; w: number; h: number }

/** Items within this Δy belong to the same text line. */
const LINE_BAND = 3
/** A horizontal gap wider than this is a column gutter, not word spacing. */
const COLUMN_GAP = 12
/** How close to the entry's left edge counts as "back at the margin". */
const MARGIN_TOL = 3
/** A continuation line at least this far right of the margin marks the entry
 *  as hanging-indent style — then any later margin-return line ends it. */
const HANG_INDENT_MIN = 5
/** Vertical gap beyond this many line-heights is a paragraph break. */
const GAP_FACTOR = 1.8
/** Never fit a box taller than this fraction of the page. */
const MAX_HEIGHT_FRAC = 0.25
/** Padding around the fitted glyph bounding box. */
const PAD = 4

type Line = { y: number; items: PreviewTextItem[] }

/** The maximal run of `line`'s items around the one nearest `seedX`, never
 *  expanding across a gap wider than `COLUMN_GAP` — SumatraPDF's
 *  LineRunExtent, at item rather than glyph granularity. */
function runExtent(line: Line, seedX: number): { left: number; right: number; items: PreviewTextItem[] } {
  const its = [...line.items].sort((a, b) => a.x - b.x)
  let seed = 0
  let best = Infinity
  its.forEach((it, i) => {
    const d = seedX < it.x ? it.x - seedX : seedX > it.x + it.w ? seedX - (it.x + it.w) : 0
    if (d < best) {
      best = d
      seed = i
    }
  })
  let lo = seed
  let hi = seed
  while (lo > 0 && its[lo].x - (its[lo - 1].x + its[lo - 1].w) <= COLUMN_GAP) lo--
  while (hi < its.length - 1 && its[hi + 1].x - (its[hi].x + its[hi].w) <= COLUMN_GAP) hi++
  const items = its.slice(lo, hi + 1)
  return { left: items[0].x, right: items[items.length - 1].x + items[items.length - 1].w, items }
}

function runText(run: { items: PreviewTextItem[] }): string {
  return run.items
    .map((it) => it.str)
    .join('')
    .trimStart()
}

/**
 * The bounding box of the single list entry (bibliography item, glossary
 * entry, …) the destination `destX`/`destY` points at, or `null` when the
 * page's text layout doesn't yield one (sparse/image-only page, destination
 * in empty space) — callers then fall back to a plain window on the page.
 */
export function detectEntryBox(
  items: PreviewTextItem[],
  destX: number | null,
  destY: number,
  pageHeight: number,
): EntryBox | null {
  const glyphs = items.filter((it) => it.str.trim() !== '')
  if (glyphs.length < 8) return null // sparse page — no layout to fit to

  // 1. Cluster items into lines by y.
  const sorted = [...glyphs].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: Line[] = []
  for (const it of sorted) {
    const line = lines[lines.length - 1]
    if (line && Math.abs(it.y - line.y) <= LINE_BAND) line.items.push(it)
    else lines.push({ y: it.y, items: [it] })
  }

  // 2. Anchor line: nearest to destY within [-5, +30], with text at or right
  // of the destination's column (a small left tolerance, so a "[1]" starting
  // a few units left of an imprecise destX still matches).
  const colLeft = destX !== null ? destX - 15 : -Infinity
  let anchor: Line | null = null
  let bestDist = Infinity
  for (const line of lines) {
    if (line.y < destY - 5 || line.y > destY + 30) continue
    if (!line.items.some((it) => it.x + it.w > colLeft)) continue
    const d = Math.abs(line.y - destY)
    if (d < bestDist) {
      bestDist = d
      anchor = line
    }
  }
  if (!anchor) return null

  // 3. The entry's first line: the gap-bounded run around the destination.
  // Expanding left also recovers the entry's real start when a
  // poorly-authored link's destX lands mid-line.
  const first = runExtent(anchor, destX ?? anchor.items[0].x)
  const entryLeft = first.left
  const lineH = Math.max(8, first.items.reduce((m, it) => Math.max(m, it.h), 0))

  // 4. Walk following lines; collect the entry's continuation lines.
  const included = [first]
  let lastY = anchor.y
  let colRight = first.right
  let sawIndent = false
  for (const line of lines) {
    if (line.y <= anchor.y + LINE_BAND) continue
    const run = runExtent(line, entryLeft)
    // A line with no text in this column (only the neighbouring column's) is
    // neither part of the entry nor its terminator.
    if (run.right < entryLeft - COLUMN_GAP || run.left > colRight + 2 * COLUMN_GAP) continue
    if (line.y - lastY > GAP_FACTOR * lineH) break // paragraph gap — entry over
    const atMargin = run.left <= entryLeft + MARGIN_TOL
    if (atMargin && (sawIndent || /^[[\d]/.test(runText(run)))) break // next entry
    if (line.y + lineH - anchor.y > MAX_HEIGHT_FRAC * pageHeight) break
    if (!atMargin && run.left >= entryLeft + HANG_INDENT_MIN) sawIndent = true
    included.push(run)
    lastY = line.y
    colRight = Math.max(colRight, run.right)
  }

  // 5. Padded bounding box of everything included.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const run of included) {
    for (const it of run.items) {
      minX = Math.min(minX, it.x)
      minY = Math.min(minY, it.y)
      maxX = Math.max(maxX, it.x + it.w)
      maxY = Math.max(maxY, it.y + it.h)
    }
  }
  return { x: minX - PAD, y: minY - PAD, w: maxX - minX + 2 * PAD, h: maxY - minY + 2 * PAD }
}

/**
 * The reference number of a numeric citation ("[3]", "[1, 2]", "[3-5]") that
 * `offset` sits inside in `text`, or `null` — for PDFs without link
 * annotations (publisher-stamped IEEE Xplore downloads drop hyperref's links,
 * leaving the blue "[3]" as plain text). Port of SumatraPDF's
 * DetectNumericCitationInPageText: a list or range yields the number token
 * nearest the cursor. Works on one pdf.js text item, which holds a whole
 * line, so a citation is never split across items.
 */
export function detectNumericCitation(text: string, offset: number): number | null {
  const isListChar = (c: string) => /[\d\s,\-–]/.test(c)
  let open = -1
  for (let i = Math.min(offset, text.length - 1); i >= 0; i--) {
    if (text[i] === '[') {
      open = i
      break
    }
    if (text[i] === ']' && i === offset) continue // cursor on the closing bracket
    if (!isListChar(text[i])) break
  }
  if (open < 0) return null
  const close = text.slice(open + 1).search(/[^\d\s,\-–]/) + open + 1
  if (close <= open + 1 || text[close] !== ']') return null

  let best: number | null = null
  let bestDist = Infinity
  for (const m of text.slice(open + 1, close).matchAll(/\d+/g)) {
    const start = open + 1 + m.index
    const end = start + m[0].length - 1
    const dist = offset < start ? start - offset : offset > end ? offset - end : 0
    const n = Number(m[0])
    if (n >= 1 && dist < bestDist) {
      bestDist = dist
      best = n
    }
  }
  return best
}

/** Wider than word spacing, narrower than a column gutter or hanging indent. */
const LABEL_LEFT_GAP = 12

/**
 * Where reference `num`'s entry starts on a page: an item beginning with a
 * standalone "[num]" label that has clear space to its left (the margin, or a
 * two-column list's gutter), or `null`. Port of SumatraPDF's
 * FindNumericReferenceInPageText, stricter in one point: the label must be
 * followed by whitespace or nothing, so body text wrapping to a line start
 * ("[4]. Yet", "[2], [6]") is not mistaken for the entry.
 */
export function findNumericReference(items: PreviewTextItem[], num: number): { x: number; y: number } | null {
  const label = new RegExp(`^\\s*\\[${num}\\](\\s|$)`)
  for (const it of items) {
    if (!label.test(it.str)) continue
    const tol = Math.max(it.h, 8)
    const crowded = items.some(
      (o) =>
        o !== it &&
        o.str.trim() !== '' &&
        Math.abs(o.y - it.y) <= tol &&
        o.x < it.x &&
        o.x + o.w > it.x - LABEL_LEFT_GAP,
    )
    if (!crowded) return { x: it.x, y: it.y }
  }
  return null
}
