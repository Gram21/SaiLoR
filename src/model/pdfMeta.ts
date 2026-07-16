import { pdfjs } from '../platform/pdfjs'

/**
 * Best-effort extraction of a paper's title and authors from its PDF, used to
 * pre-fill the project editor. Two sources, in order:
 *
 *  1. The PDF's embedded metadata (`Title` / `Author`). Cheap and exact when
 *     present — but plenty of publisher toolchains leave it blank or fill it
 *     with junk ("Microsoft Word - paper_final_v3.doc"), so it is validated.
 *  2. A layout heuristic over page 1: the largest text near the top is the
 *     title, and the lines just under it are the authors.
 *
 * Everything here is a guess, so it only ever *pre-fills* fields the user can
 * correct. When unsure it returns nothing rather than something wrong.
 */

export interface PdfMeta {
  title?: string
  authors?: string[]
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
  return tokens.every((t) => PARTICLE.test(t) || /^[A-Z]/.test(t))
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
        // Trailing/leading digits used as affiliation keys ("Jane Doe 1").
        .replace(/(^\s*\d+\s*)|(\s*\d+\s*$)/g, '')
        .replace(/\s+/g, ' ')
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

/** One rendered line of text, with the largest font size used in it. */
interface Line {
  y: number
  size: number
  text: string
  /**
   * The line's text split at column gaps. A two-column author block puts each
   * author on the *same baseline*, so they arrive as one `Line` — but they are
   * separate items, not one run of prose, and only the gap says so.
   */
  segments: string[]
}

/**
 * A horizontal gap this many times the font size starts a new segment. A word
 * space is a fraction of the font size even in justified text, while a column
 * gutter is several times it, so anything in between is a safe place to cut.
 */
const COLUMN_GAP_RATIO = 1.5

/** Group a page's text items into lines, keeping each line's dominant font size. */
function toLines(items: { str: string; transform: number[]; width?: number }[]): Line[] {
  const byY = new Map<
    number,
    { size: number; parts: { x: number; width: number; str: string }[] }
  >()
  for (const item of items) {
    if (!item.str.trim()) continue
    const size = Math.abs(item.transform[3])
    const y = Math.round(item.transform[5])
    // Merge items whose baselines are within a couple of points (same line).
    let key = y
    for (const existing of byY.keys()) {
      if (Math.abs(existing - y) <= 2) {
        key = existing
        break
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
      const segments: string[] = []
      let current = ''
      let prevEnd = NaN
      for (const p of parts) {
        // Adjacent runs are joined bare: pdf.js splits a single phrase into
        // several runs on a font or kerning change, and any separator here
        // would land mid-word.
        if (current !== '' && p.x - prevEnd > l.size * COLUMN_GAP_RATIO) {
          segments.push(current)
          current = ''
        }
        current += p.str
        prevEnd = p.x + p.width
      }
      if (current !== '') segments.push(current)
      const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
      return {
        y,
        size: l.size,
        // Joined with a space, not bare: whatever separated two columns, it was
        // not nothing.
        text: clean(segments.join(' ')),
        segments: segments.map(clean).filter(Boolean),
      }
    })
    .filter((l) => l.text)
    .sort((a, b) => b.y - a.y) // PDF origin is bottom-left, so top of page first
}

/** Where the body text starts — nothing at or below this is title/author material. */
const BODY_START = /^(abstract|introduction|keywords|index terms|ccs concepts|a\.?b\.?s\.?t\.?r\.?a\.?c\.?t)\b/i

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
  const authors: string[] = []
  for (let j = i; j < top.length && j < i + 4; j++) {
    const line = top[j]
    if (BODY_START.test(line.text)) break
    // Per column, not per line: a two-column author block has no punctuation
    // between the names — only the gutter — so parsing the joined line would
    // read "Jan Keim" and "Angelika Kaplan" as one person.
    // Strict: this is a guess at which line holds the authors, so a body
    // sentence must not be mistaken for a list of names.
    const names = line.segments.flatMap((seg) => parseAuthorList(seg, true))
    if (names.length === 0) continue
    authors.push(...names)
    // One line of names is the common case; stop once we have some.
    if (authors.length > 0) break
  }
  if (authors.length > 0) out.authors = authors
  return out
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

    // 2. Layout heuristic for whatever the metadata didn't give us.
    if (!result.title || !result.authors) {
      const page = await doc.getPage(1)
      const content = await page.getTextContent()
      const lines = toLines(
        content.items as { str: string; transform: number[]; width?: number }[],
      )
      const guess = titleAndAuthorsFromLines(lines, page.view[3])
      if (!result.title && guess.title) result.title = guess.title
      if (!result.authors && guess.authors) result.authors = guess.authors
    }

    await doc.destroy()
    return result
  } catch {
    // An unreadable or encrypted PDF simply yields no pre-filled fields.
    return {}
  }
}
