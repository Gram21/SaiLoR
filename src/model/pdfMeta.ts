import { pdfjs } from '../platform/pdfjs'

/**
 * Best-effort extraction of a paper's title, authors, and abstract from its
 * PDF, used to pre-fill the project editor and (for the abstract alone) a
 * screening paper opened with none recorded yet — see `extractScreeningAbstract`
 * in `state/store.ts`. Title/authors come from two sources, in order:
 *
 *  1. The PDF's embedded metadata (`Title` / `Author`). Cheap and exact when
 *     present — but plenty of publisher toolchains leave it blank or fill it
 *     with junk ("Microsoft Word - paper_final_v3.doc"), so it is validated.
 *  2. A layout heuristic over page 1: the largest text near the top is the
 *     title, and the lines just under it are the authors.
 *
 * The abstract has no metadata source (PDFs carry no standard "Abstract"
 * field), so it is always the layout heuristic: find a line starting with the
 * word "Abstract" below the title/author block, and capture what follows
 * until the next section starts — see `abstractFromLines`.
 *
 * Everything here is a guess, so it only ever *pre-fills* a field the user can
 * correct, and every extracted abstract is flagged (`Paper.abstractFromPdf`)
 * for a durable "unverified" warning wherever it is shown — see
 * `ScreeningRecord.tsx`. When unsure, this returns nothing rather than
 * something wrong.
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
  // Needs at least two words.
  if (s.split(/\s+/).length < 2) return false
  return true
}

export function cleanTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

const AFFILIATION = /(universit|institut|department|faculty|school|laborator|college|inc\.|gmbh|@)/i

/** A leading label on an author line ("Authors: Jane Doe"). */
const AUTHOR_LABEL = /^\s*(authors?|by)\s*[:\-—]?\s*/i

/** Name particles that are legitimately lower-case ("Jane van der Berg"). */
const PARTICLE = /^(van|von|de|der|den|di|da|del|della|la|le|dos|bin|ibn|of)$/i

/**
 * Does this look like a person's name rather than a sentence? Used only for the
 * layout heuristic, where we're *guessing* which line holds the authors and a
 * stray body line would otherwise be accepted. Names are short and their tokens
 * are capitalised ("Jane Doe", "A. Author"); prose is neither.
 */
function looksLikeName(s: string): boolean {
  const tokens = s.split(/\s+/)
  if (tokens.length < 2 || tokens.length > 5) return false
  // `\p{Lu}`/`\p{Lt}` (Unicode upper-/title-case), not ASCII `[A-Z]`: a name
  // like "Łukasz Kaiser" or "Ángel Cuadra" starts with an upper-case letter
  // that isn't in A–Z, and the ASCII test dropped it — and if every author on
  // the line was non-ASCII, the whole line was mistaken for prose and the
  // authors missed entirely.
  return tokens.every((t) => PARTICLE.test(t) || /^[\p{Lu}\p{Lt}]/u.test(t))
}

/**
 * Split an author line/field into individual names. Handles the usual
 * separators ("A, B and C"; "A; B") and strips the affiliation markers that
 * cling to names in a PDF's text layer (superscripts, footnote daggers, emails).
 *
 * `strict` additionally requires each entry to look like a person's name. Pass
 * it for the layout heuristic (a guess); leave it off for the PDF's `Author`
 * metadata field, which is explicitly authors and may use forms like "Doe, Jane".
 */
export function parseAuthorList(raw: string, strict = false): string[] {
  return raw
    .replace(AUTHOR_LABEL, '')
    .replace(/\band\b/gi, ',')
    .replace(/&/g, ',')
    .split(/[,;]/)
    .map((name) =>
      name
        // Superscript affiliation markers and footnote symbols.
        .replace(/[¹²³⁰-₟*†‡§¶#]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        // Trailing/leading digits used as affiliation keys ("Jane Doe 1").
        //
        // Deliberately *after* the whitespace collapse, not before. As
        // `(^\s*\d+\s*)|(\s*\d+\s*$)` against raw text, the trailing branch
        // retried at every offset of a whitespace run, which is quadratic: an
        // /Author of "a" + 256k spaces + "b" — entirely under the PDF's
        // control, and parsed for every file in a folder import — froze the
        // main thread for 36 seconds. Once runs are collapsed to one space,
        // `\s*` can match at most one character and the same intent is linear.
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
  /**
   * Left edge in PDF user space. This is what makes a *column* identifiable
   * across lines: every line of a given column shares (near enough) one `x`,
   * which is the only way to follow one column down a two-column page — see
   * `abstractFromLines`.
   */
  x: number
  text: string
}

/** One rendered line of text, with the largest font size used in it. */
export interface Line {
  y: number
  size: number
  text: string
  /**
   * The line's text split at column gaps. A two-column author block puts each
   * author on the *same baseline*, so they arrive as one `Line` — but they are
   * separate items, not one run of prose, and only the gap says so.
   */
  segments: Segment[]
}

/**
 * A horizontal gap this many times the font size starts a new segment. A word
 * space is a fraction of the font size even in justified text, while a column
 * gutter is several times it, so anything in between is a safe place to cut.
 */
const COLUMN_GAP_RATIO = 1.5

/**
 * Two segments belong to the same column when their left edges are within this
 * many points. Generous enough for the sub-point x jitter a justified column
 * shows line to line, far tighter than any real gutter (a two-column letter
 * page puts its columns ~260pt apart). Used to follow one column down the page
 * — by `abstractFromLines`, and by the author-list continuation below.
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
    // Merge items whose baselines are within a couple of points (same line).
    //
    // Via a window index rather than a scan over every baseline seen so far.
    // The scan was O(items x distinct baselines) — 80 000 items measured at
    // ~20 s, and the page count is file-controlled, so this ran per page. The
    // tolerance is +/-2 integer points, so registering that window once per new
    // baseline answers the same question by lookup. Registering only where
    // nothing is registered yet preserves the scan's "earliest matching
    // baseline wins" behaviour, which insertion order gave it for free.
    let key = keyForY.get(y)
    if (key === undefined) {
      key = y
      for (let d = -Y_TOLERANCE; d <= Y_TOLERANCE; d++) {
        if (!keyForY.has(y + d)) keyForY.set(y + d, key)
      }
    }
    const line = byY.get(key) ?? { size: 0, parts: [] }
    line.size = Math.max(line.size, size)
    // `width` is pdf.js's own measurement of the run. Without it there is no
    // way to know where a run ends, so a missing/zero width simply never
    // starts a new segment (NaN fails the comparison below) — the old
    // glued-together behaviour, rather than a guess that could cut mid-phrase.
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
        // Adjacent runs are joined bare: pdf.js splits a single phrase into
        // several runs on a font or kerning change, and any separator here
        // would land mid-word.
        if (current !== '' && p.x - prevEnd > l.size * COLUMN_GAP_RATIO) {
          segments.push({ x: currentX, text: current })
          current = ''
        }
        if (current === '') currentX = p.x
        current += p.str
        prevEnd = p.x + p.width
      }
      if (current !== '') segments.push({ x: currentX, text: current })
      const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
      return {
        y,
        size: l.size,
        // Joined with a space, not bare: whatever separated two columns, it was
        // not nothing.
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
 * keys, not more authors. They sit on their own raised baseline, so `toLines`
 * reports them as a line of their own ("1 1") *between* the two halves of a
 * wrapped author list — skipping rather than stopping at them is what lets the
 * halves find each other.
 */
const SUPERSCRIPT_SIZE_RATIO = 0.85

/** How far past the author line to look for the rest of a wrapped list. */
const AUTHOR_CONTINUATION_LINES = 3

/**
 * The names in a block of lines that together hold one author list, parsed per
 * column: each of the first line's segments is joined with the segment at the
 * same `x` on every later line, and only then split into names.
 *
 * Joining before parsing is the whole point. A name broken across a line break
 * ("… Niklas Ewald, Tobias" / "Thirolf, and Anne Koziolek") cannot be repaired
 * afterwards — parse the lines separately and "Tobias" is a lone token that
 * strict mode correctly rejects, so the author is simply gone, and "Thirolf"
 * has lost its first name. Joined, it is an ordinary comma-separated list.
 *
 * Per column, for the same reason `titleAndAuthorsFromLines` already parsed a
 * single line per segment: a two-column author block puts each author on the
 * same baseline with only the gutter between them.
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
    // when it produces *more* names than the block without it.
    //
    // That comparison is the safety rail, and it is what makes growing safe at
    // all: the line under the authors is far more often an affiliation or an
    // email row than the rest of the list. Absorbing one of those does not add
    // names — it destroys them, because the last author and the affiliation
    // fuse into a single entry ("John Smith Karlsruhe Institute of Technology")
    // that `parseAuthorList` then drops as an affiliation. So a join that helps
    // is kept and a join that hurts is rejected on its own evidence, with no
    // need to recognise an affiliation up front.
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
 * the **column that heading sits in**, up to that column's next section heading.
 *
 * **Following the column is the whole problem, and it is why `Segment` carries an
 * `x`.** On a two-column paper — the overwhelmingly common case — pdf.js reports
 * the left column's "Abstract" heading and the right column's "1 Introduction"
 * on the *same baseline*, so they arrive as one `Line` reading
 * `"Abstract 1Introduction"`, and every body line below is likewise one `Line`
 * holding a strip of each column. Reading `line.text` there interleaves two
 * unrelated columns of prose; an earlier version instead *stopped* at the first
 * multi-segment line, which on a real paper is the line immediately after the
 * heading — so it extracted nothing at all from exactly the documents this
 * exists for (verified against a real ICSE paper, which is what caught it).
 *
 * So: find the *segment* matching "Abstract", take its `x` as the column, and
 * walk down taking only each line's segment at that same `x`. A line with
 * nothing in that column (the left column ends while the right runs on) is
 * skipped, not a stop — the next section heading in *this* column is the stop.
 * A single-column paper is the degenerate case of the same rule: one segment
 * per line, all at the same `x`.
 *
 * The start line must also not be the page's largest text: a title is virtually
 * always set in the biggest font and an "Abstract" heading never is, so this
 * rejects a title that genuinely begins with the word ("Abstract Interpretation
 * of…", a real if uncommon pattern). An earlier version used a vertical cutoff
 * for that instead — wrong, because a real abstract routinely starts well above
 * a page's midpoint when the title block is short.
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
 * Join lines of a wrapped paragraph, healing the hyphens justified text breaks
 * words across lines with ("archi-" + "tectural" → "architectural"). Without
 * this the extracted abstract reads visibly broken, which matters here because
 * unlike the title/author guesses this text is displayed to be *read* — it is
 * what a screening decision gets made on.
 *
 * A line-final hyphen is joined only when the next line starts lower-case,
 * which is what a mid-word syllable break looks like. The cost is a genuine
 * line-final compound hyphen ("state-" / "of-the-art") losing its hyphen; that
 * is rare, cosmetic, and lands in a field already labelled as machine-extracted
 * and unverified — whereas leaving every syllable break in place is neither
 * rare nor cosmetic.
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
