import { pdfjs } from '../platform/pdfjs'

/**
 * Best-effort extraction of a paper's title, authors, and abstract from its PDF
 * (used to pre-fill the project editor, and via `extractScreeningAbstract` in
 * `state/store.ts` for screening). Title/authors prefer embedded metadata
 * (`Title`/`Author`), validated since it's often blank or junk, falling back to
 * a layout heuristic over page 1. The abstract has no metadata field, so it's
 * always the layout heuristic — see `abstractFromLines`.
 *
 * Everything here is a guess: it only pre-fills fields the user can correct,
 * every extracted abstract is flagged `Paper.abstractFromPdf` for an
 * "unverified" warning (see `ScreeningRecord.tsx`), and when unsure this
 * returns nothing rather than something wrong.
 */

export interface PdfMeta {
  title?: string
  authors?: string[]
  abstract?: string
}

/** Metadata titles that are really tool artefacts, not paper titles. */
const JUNK_TITLE = /^(untitled|microsoft word|document\d*|paper|manuscript|main|template|\d+)\b/i

/** True if a string is plausibly a paper title rather than a filename or artefact. */
export function isPlausibleTitle(raw: string): boolean {
  const s = raw.trim()
  if (s.length < 6 || s.length > 300) return false
  if (JUNK_TITLE.test(s)) return false
  // A bare filename ("smith2024.pdf", "paper_final.docx") is not a title.
  if (/\.(pdf|docx?|tex)$/i.test(s)) return false
  if (s.split(/\s+/).length < 2) return false
  return true
}

export function cleanTitle(raw: string): string {
  // NFC: metadata is a separate source from the text layer (see `toLines`'s
  // `clean`) and can carry the same decomposed-accent artefact independently.
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim()
}

const AFFILIATION = /(universit|institut|department|faculty|school|laborator|college|inc\.|gmbh|@)/i

/** A leading label on an author line ("Authors: Jane Doe"). */
const AUTHOR_LABEL = /^\s*(authors?|by)\s*[:\-—]?\s*/i

/** Name particles that are legitimately lower-case ("Jane van der Berg"). */
const PARTICLE = /^(van|von|de|der|den|di|da|del|della|la|le|dos|bin|ibn|of)$/i

/**
 * Does this look like a person's name rather than a sentence? Used only for the
 * layout heuristic, to reject a stray body line that would otherwise pass for
 * an author line.
 */
function looksLikeName(s: string): boolean {
  const tokens = s.split(/\s+/)
  if (tokens.length < 2 || tokens.length > 5) return false
  // `\p{Lu}`/`\p{Lt}` (Unicode upper/title-case), not ASCII `[A-Z]`: names like
  // "Łukasz Kaiser" start with a capital outside A–Z, and an ASCII test would
  // mistake an all-non-ASCII author line for prose and drop it entirely.
  return tokens.every((t) => PARTICLE.test(t) || /^[\p{Lu}\p{Lt}]/u.test(t))
}

/**
 * Split an author line/field into individual names, handling the usual
 * separators and stripping affiliation markers that cling to names in a PDF's
 * text layer.
 *
 * `strict` additionally requires each entry to look like a person's name: pass
 * it for the layout heuristic (a guess), leave it off for the PDF's `Author`
 * metadata field, which may use forms like "Doe, Jane".
 */
export function parseAuthorList(raw: string, strict = false): string[] {
  return raw
    .replace(AUTHOR_LABEL, '')
    .replace(/\band\b/gi, ',')
    .replace(/&/g, ',')
    .split(/[,;]/)
    .map((name) =>
      name
        // NFC: same decomposed-accent risk as `cleanTitle`, separate source.
        .normalize('NFC')
        // Superscript affiliation markers and footnote symbols.
        .replace(/[¹²³⁰-₟*†‡§¶#]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        // Trailing/leading affiliation-key digits ("Jane Doe 1"). Must run
        // *after* the whitespace collapse: against raw text the trailing
        // branch retried at every offset of a run of spaces, which is
        // quadratic — an attacker-sized run of spaces in one /Author field
        // froze the main thread for 36s. Collapsed runs make it linear.
        .replace(/^\d+\s?|\s?\d+$/g, '')
        .trim(),
    )
    .filter((name) => {
      if (name.length < 3 || name.length > 60) return false
      if (AFFILIATION.test(name)) return false // an affiliation, not a person
      if (!/[a-z]/i.test(name)) return false
      if (strict && !looksLikeName(name)) return false
      return true
    })
}

/** One run of text on a line, and where it starts. */
export interface Segment {
  /** Left edge in PDF user space — shared (near enough) by every line of one
   *  column, which is how `abstractFromLines` follows a column down the page. */
  x: number
  text: string
}

/** One rendered line of text, with the largest font size used in it. */
export interface Line {
  y: number
  size: number
  text: string
  /** Text split at column gaps: a two-column author block puts each author on
   *  the same baseline, so they arrive as one `Line` but are separate items. */
  segments: Segment[]
}

/** A horizontal gap this many times the font size starts a new segment — safely
 *  between a justified word space and a column gutter. */
const COLUMN_GAP_RATIO = 1.5

/**
 * Segments within this many points of left edge belong to the same column —
 * generous for justified-text jitter, tighter than any real gutter (~260pt).
 * Used to follow a column down the page, by `abstractFromLines` and the
 * author-list continuation below.
 */
const COLUMN_X_TOLERANCE = 12

/** Baselines this many points apart or less are treated as the same line. */
const Y_TOLERANCE = 2

/** Group a page's text items into lines, keeping each line's dominant font size. */
export function toLines(items: { str: string; transform: number[]; width?: number }[]): Line[] {
  const byY = new Map<
    number,
    { size: number; parts: { x: number; width: number; str: string }[] }
  >()
  /** Every y within Y_TOLERANCE of a canonical baseline, mapped to it. */
  const keyForY = new Map<number, number>()
  for (const item of items) {
    if (!item.str.trim()) continue
    const size = Math.abs(item.transform[3])
    const y = Math.round(item.transform[5])
    // Merge items whose baselines are within a couple of points (same line),
    // via a window index rather than an O(items x distinct baselines) scan —
    // the scan measured ~20s at 80k items. Registering the +/-2pt window only
    // where unset preserves "earliest matching baseline wins".
    let key = keyForY.get(y)
    if (key === undefined) {
      key = y
      for (let d = -Y_TOLERANCE; d <= Y_TOLERANCE; d++) {
        if (!keyForY.has(y + d)) keyForY.set(y + d, key)
      }
    }
    const line = byY.get(key) ?? { size: 0, parts: [] }
    line.size = Math.max(line.size, size)
    // Missing/zero width never starts a new segment (NaN fails the comparison
    // below) — glues the run together rather than guessing where it ends.
    line.parts.push({
      x: item.transform[4],
      width: typeof item.width === 'number' && item.width > 0 ? item.width : NaN,
      str: item.str,
    })
    byY.set(key, line)
  }
  return [...byY.entries()]
    .map(([y, l]) => {
      const parts = [...l.parts].sort((a, b) => a.x - b.x)
      const segments: Segment[] = []
      let current = ''
      let currentX = NaN
      let prevEnd = NaN
      for (const p of parts) {
        // Adjacent runs join bare: pdf.js splits one phrase into several runs
        // on a font/kerning change, and any separator here would land mid-word.
        if (current !== '' && p.x - prevEnd > l.size * COLUMN_GAP_RATIO) {
          segments.push({ x: currentX, text: current })
          current = ''
        }
        if (current === '') currentX = p.x
        current += p.str
        prevEnd = p.x + p.width
      }
      if (current !== '') segments.push({ x: currentX, text: current })
      // NFC after joining (not per-item): some fonts' ToUnicode maps split an
      // accented letter into base + combining mark across adjacent items, and
      // only a post-join normalize recomposes a pair that straddled the join.
      const clean = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim()
      return {
        y,
        size: l.size,
        // Joined with a space: whatever separated two columns wasn't nothing.
        text: clean(segments.map((s) => s.text).join(' ')),
        segments: segments
          .map((s) => ({ x: s.x, text: clean(s.text) }))
          .filter((s) => s.text),
      }
    })
    .filter((l) => l.text)
    .sort((a, b) => b.y - a.y) // PDF origin is bottom-left, so top of page first
}

/** Where the body text starts — nothing at or below this is title/author material. */
const BODY_START = /^(abstract|introduction|keywords|index terms|ccs concepts|a\.?b\.?s\.?t\.?r\.?a\.?c\.?t)\b/i

/**
 * A line this much smaller than the author line is superscript affiliation
 * keys, not more authors — they land on their own baseline between the two
 * halves of a wrapped list, so they must be skipped, not treated as a stop.
 */
const SUPERSCRIPT_SIZE_RATIO = 0.85

/** How far past the author line to look for the rest of a wrapped list. */
const AUTHOR_CONTINUATION_LINES = 3

/**
 * The names in a block of lines that together hold one author list, parsed per
 * column: each of the first line's segments is joined with the segment at the
 * same `x` on every later line, and only then split into names.
 *
 * Joining before parsing is the whole point: a name broken across a line break
 * ("… Niklas Ewald, Tobias" / "Thirolf, and Anne Koziolek") can't be repaired
 * after separate parsing — "Tobias" is a lone token strict mode rejects, and
 * "Thirolf" loses its first name. Joined, it's an ordinary comma-separated list.
 */
function namesFromAuthorBlock(block: Line[]): string[] {
  const [first, ...rest] = block
  return first.segments.flatMap((seg) => {
    let text = seg.text
    for (const line of rest) {
      const cont = line.segments.find((s) => Math.abs(s.x - seg.x) <= COLUMN_X_TOLERANCE)
      if (cont) text += ` ${cont.text}`
    }
    // Strict: this is a guess at which lines hold the authors, so a body
    // sentence must not be mistaken for a list of names.
    return parseAuthorList(text, true)
  })
}

/** Title + authors from a page's lines: biggest text at the top, then what follows. */
export function titleAndAuthorsFromLines(lines: Line[], pageHeight: number): PdfMeta {
  // Only the top of the page can hold the title block.
  const top = lines.filter((l) => l.y > pageHeight * 0.45)
  if (top.length === 0) return {}

  const maxSize = Math.max(...top.map((l) => l.size))
  const titleStart = top.findIndex((l) => l.size >= maxSize - 0.5)
  if (titleStart === -1) return {}

  // The title can wrap, so take the contiguous run of same-size lines.
  const titleLines: string[] = []
  let i = titleStart
  for (; i < top.length; i++) {
    if (top[i].size < maxSize - 0.5) break
    if (BODY_START.test(top[i].text)) break
    titleLines.push(top[i].text)
  }
  const title = cleanTitle(titleLines.join(' '))
  const out: PdfMeta = {}
  if (isPlausibleTitle(title)) out.title = title

  // Authors: the next few smaller lines, stopping at the abstract/affiliations.
  let authors: string[] = []
  for (let j = i; j < top.length && j < i + 4; j++) {
    if (BODY_START.test(top[j].text)) break
    let block = [top[j]]
    let best = namesFromAuthorBlock(block)
    if (best.length === 0) continue // not the author line — a superscript row, or prose

    // The list may wrap. Grow the block a line at a time, keeping a line only
    // when it produces *more* names than the block without it — the line below
    // is often an affiliation/email row, and absorbing one fuses the last
    // author with it into one entry that `parseAuthorList` then drops.
    for (let k = j + 1; k < top.length && k <= j + AUTHOR_CONTINUATION_LINES; k++) {
      const next = top[k]
      if (BODY_START.test(next.text)) break
      // Skip, don't stop: superscript affiliation keys land on their own line
      // in the middle of a wrapped list.
      if (next.size < top[j].size * SUPERSCRIPT_SIZE_RATIO) continue
      const grown = namesFromAuthorBlock([...block, next])
      if (grown.length <= best.length) break
      block = [...block, next]
      best = grown
    }
    authors = best
    break
  }
  if (authors.length > 0) out.authors = authors
  return out
}

/** A line starting the abstract, allowing a same-line lead-in ("Abstract—", "Abstract:", "ABSTRACT."). */
const ABSTRACT_START = /^abstract\b\s*[:.—-]?\s*/i

/** Where the abstract ends: the next section a paper's front matter conventionally has. */
const ABSTRACT_END =
  /^(introduction|keywords?|index terms|ccs concepts|categories and subject descriptors|acm reference format|general terms|1\.?\s+introduction|i\.\s+introduction)\b/i

/** Below this many characters, a "match" is more likely noise than a real abstract. */
const MIN_ABSTRACT_LENGTH = 150
/** Above this, something has gone wrong (no end marker found) — stop trusting it. */
const MAX_ABSTRACT_LENGTH = 4000
/** Safety valve alongside the length cap, in case `ABSTRACT_END` never matches. */
const MAX_ABSTRACT_LINES = 40

/**
 * The abstract from a page's lines: the text under the "Abstract" heading, in
 * the column that heading sits in, up to that column's next section heading.
 *
 * On a two-column paper, pdf.js reports the left column's "Abstract" heading
 * and the right column's "1 Introduction" on the same baseline, so they and
 * every body line below arrive as one `Line` holding a strip of each column.
 * Reading `line.text` there interleaves two unrelated columns; stopping at the
 * first multi-segment line instead (an earlier version) extracted nothing at
 * all from two-column papers. So: find the *segment* matching "Abstract", take
 * its `x` as the column, and walk down taking only each line's segment at that
 * `x` — a line with nothing in that column is skipped, not a stop; the next
 * section heading in *this* column is the stop. A single-column paper is the
 * degenerate case (one segment per line, all at the same `x`).
 *
 * The start line must also not be the page's largest text, since a title is
 * virtually always the biggest font and an "Abstract" heading never is — this
 * rejects a title that genuinely begins with the word. A vertical cutoff
 * (an earlier version) is wrong here since a short title block can leave a
 * real abstract starting well above the page's midpoint.
 */
export function abstractFromLines(lines: Line[]): string | undefined {
  if (lines.length === 0) return undefined
  const maxSize = Math.max(...lines.map((l) => l.size))

  let startIdx = -1
  let columnX = NaN
  let leadIn = ''
  for (let i = 0; i < lines.length; i++) {
    // `- 0.5` mirrors `titleAndAuthorsFromLines`'s own "is this the title's
    // size" epsilon, so the two agree on what counts as title-sized.
    if (lines[i].size >= maxSize - 0.5) continue
    const seg = lines[i].segments.find((s) => ABSTRACT_START.test(s.text))
    if (!seg) continue
    startIdx = i
    columnX = seg.x
    leadIn = seg.text.replace(ABSTRACT_START, '').trim()
    break
  }
  if (startIdx === -1) return undefined

  const parts: string[] = []
  if (leadIn) parts.push(leadIn)

  for (let i = startIdx + 1; i < lines.length && i <= startIdx + MAX_ABSTRACT_LINES; i++) {
    const seg = lines[i].segments.find((s) => Math.abs(s.x - columnX) <= COLUMN_X_TOLERANCE)
    if (!seg) continue // nothing in this column on this line — not an ending
    if (ABSTRACT_END.test(seg.text)) break
    parts.push(seg.text)
  }

  const abstract = joinWrappedLines(parts)
  if (abstract.length < MIN_ABSTRACT_LENGTH || abstract.length > MAX_ABSTRACT_LENGTH) return undefined
  return abstract
}

/**
 * Join lines of a wrapped paragraph, healing hyphens justified text breaks
 * words across lines with ("archi-" + "tectural" → "architectural") — unlike
 * the title/author guesses, this text is displayed to be *read* for screening.
 *
 * Joined only when the next line starts lower-case (a mid-word break). Cost: a
 * genuine line-final compound hyphen ("state-of-the-art") loses its hyphen,
 * which is rare/cosmetic versus leaving every syllable break unhealed.
 */
function joinWrappedLines(parts: string[]): string {
  let out = ''
  for (const part of parts) {
    if (out === '') {
      out = part
      continue
    }
    // ASCII hyphen, plus the U+2010–U+2015 dashes a typesetter may emit instead.
    if (/[-‐-―]$/.test(out) && /^[a-z]/.test(part)) out = out.slice(0, -1) + part
    else out += ` ${part}`
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Read a PDF's title/authors. Never throws — returns {} when it can't tell. */
export async function extractPdfMeta(data: ArrayBuffer): Promise<PdfMeta> {
  try {
    const doc = await pdfjs.getDocument({ data }).promise
    const result: PdfMeta = {}

    // 1. Embedded metadata.
    try {
      const meta = await doc.getMetadata()
      const info = meta.info as { Title?: string; Author?: string } | undefined
      const rawTitle = info?.Title ? cleanTitle(info.Title) : ''
      if (rawTitle && isPlausibleTitle(rawTitle)) result.title = rawTitle
      const rawAuthor = info?.Author?.trim()
      if (rawAuthor) {
        const authors = parseAuthorList(rawAuthor)
        if (authors.length > 0) result.authors = authors
      }
    } catch {
      // No/broken metadata — fall through to the layout heuristic.
    }

    // 2. Layout heuristic over page 1 — always run: the abstract has no
    //    metadata source to check first, unlike title/authors above.
    const page = await doc.getPage(1)
    const content = await page.getTextContent()
    const lines = toLines(content.items as { str: string; transform: number[]; width?: number }[])
    const pageHeight = page.view[3]

    if (!result.title || !result.authors) {
      const guess = titleAndAuthorsFromLines(lines, pageHeight)
      if (!result.title && guess.title) result.title = guess.title
      if (!result.authors && guess.authors) result.authors = guess.authors
    }

    const abstract = abstractFromLines(lines)
    if (abstract) result.abstract = abstract

    await doc.destroy()
    return result
  } catch {
    // An unreadable or encrypted PDF simply yields no pre-filled fields.
    return {}
  }
}
