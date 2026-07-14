import { pdfjs } from '../platform/pdfjs'

/**
 * Full plain-text extraction of a paper's PDF, so it can be pasted into an LLM
 * prompt instead of uploading the PDF itself (cheaper, and works with models
 * that don't accept file attachments).
 */

export interface PdfText {
  /** Full text, pages separated by a "[page N]" marker on its own line. */
  text: string
  pages: number
  /** True when extraction produced (almost) nothing — a scanned, image-only PDF. */
  empty: boolean
}

/**
 * Below this many non-whitespace characters across the whole document, there's
 * nothing here worth sending to an LLM — treat it as a scanned/image-only PDF
 * and let the caller fall back (e.g. to uploading the PDF itself).
 */
const EMPTY_CHAR_THRESHOLD = 200

/**
 * Merge a page's text items into reading-order lines. Mirrors the layout
 * heuristic in pdfMeta.ts (bucket by baseline y, sort each bucket by x) rather
 * than naively joining `item.str` in item order — pdf.js does not promise
 * items in reading order, and a two-column paper joined naively is soup.
 * Duplicated here (not imported) to keep this module independent of pdfMeta.ts.
 */
function linesFromItems(items: { str: string; transform: number[] }[]): string[] {
  const byY = new Map<number, { x: number; str: string }[]>()
  for (const item of items) {
    if (!item.str.trim()) continue
    const y = Math.round(item.transform[5])
    // Merge items whose baselines are within a couple of points (same line).
    let key = y
    for (const existing of byY.keys()) {
      if (Math.abs(existing - y) <= 2) {
        key = existing
        break
      }
    }
    const parts = byY.get(key) ?? []
    parts.push({ x: item.transform[4], str: item.str })
    byY.set(key, parts)
  }
  return [...byY.entries()]
    .sort((a, b) => b[0] - a[0]) // PDF origin is bottom-left, so top of page first
    .map(([, parts]) =>
      parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line.length > 0)
}

/** Collapse the blank-line runs and trailing whitespace a per-line join accumulates — this text is going into a token-billed prompt. */
function collapseWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extract the full text of a PDF, one `[page N]` block per page.
 *
 * Only the "document can't be opened at all" failure is allowed to throw —
 * that's a genuine pdf.js error (corrupt/encrypted file) the caller needs to
 * know about. A single bad page inside an otherwise-readable document does
 * not sink the rest of the extraction; it's just skipped.
 */
export async function extractPdfText(
  data: ArrayBuffer,
  opts: { maxPages?: number } = {},
): Promise<PdfText> {
  const doc = await pdfjs.getDocument({ data }).promise
  try {
    const total = doc.numPages
    const limit =
      opts.maxPages !== undefined && opts.maxPages > 0 ? Math.min(opts.maxPages, total) : total

    const blocks: string[] = []
    for (let i = 1; i <= limit; i++) {
      let pageText = ''
      try {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        pageText = linesFromItems(content.items as { str: string; transform: number[] }[]).join(
          '\n',
        )
      } catch {
        // Leave this page's block empty rather than failing the whole extraction.
      }
      blocks.push(`[page ${i}]\n${pageText}`)
    }
    if (limit < total) {
      blocks.push(`[${total - limit} more page(s) omitted]`)
    }

    const text = collapseWhitespace(blocks.join('\n\n'))
    const nonWhitespace = text.replace(/\s/g, '').length
    return { text, pages: total, empty: nonWhitespace < EMPTY_CHAR_THRESHOLD }
  } finally {
    await doc.destroy()
  }
}
