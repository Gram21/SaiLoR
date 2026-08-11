import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { extractPdfText, linesFromItems } from './pdfText'
import { pdfjs } from '../platform/pdfjs'

// Under vitest/jsdom, import.meta.url for platform/pdfjs.ts resolves to an
// http: URL (Vite's dev-server style module URL), which pdf.js's Node "fake
// worker" fallback can't dynamically import (it only accepts file:/data:
// schemes). Point it at the real on-disk worker file instead — this only
// rebinds the singleton's config, not its behavior.
const require = createRequire(import.meta.url)
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'),
).href

/**
 * Load a sample PDF's bytes as a real ArrayBuffer (what a File's .arrayBuffer()
 * yields). pdf.js explicitly rejects a Node `Buffer` (a Uint8Array subclass), so
 * this copies into a plain Uint8Array first.
 */
function loadPdf(path: string): ArrayBuffer {
  const buf = readFileSync(path)
  return new Uint8Array(buf).buffer
}

describe('linesFromItems', () => {
  it('recomposes an accented letter split across two adjacent items into one precomposed character', () => {
    // Some fonts' ToUnicode maps hand pdf.js a base letter and a combining
    // mark as separate runs ("e" + U+0301 COMBINING ACUTE ACCENT) rather than
    // one precomposed "é" — the bug this guards: without NFC normalization
    // after the join, "café" round-trips as "cafe´" (or similar), not "café".
    const items = [
      { str: 'caf', transform: [0, 0, 0, 0, 0, 100] },
      { str: 'e', transform: [0, 0, 0, 0, 10, 100] },
      { str: '́', transform: [0, 0, 0, 0, 15, 100] },
    ]
    expect(linesFromItems(items)).toEqual(['café'])
  })

  it('is a no-op for text that was already precomposed', () => {
    const items = [{ str: 'café résumé', transform: [0, 0, 0, 0, 0, 100] }]
    expect(linesFromItems(items)).toEqual(['café résumé'])
  })
})

describe('extractPdfText', () => {
  it('reports the right page count and a marker per page for a multi-page PDF', async () => {
    const result = await extractPdfText(loadPdf('samples/pdfs/multipage.pdf'))
    expect(result.pages).toBe(4)
    for (let i = 1; i <= 4; i++) {
      expect(result.text).toContain(`[page ${i}]`)
    }
    // Markers must appear in order, not just be present somewhere.
    const positions = [1, 2, 3, 4].map((i) => result.text.indexOf(`[page ${i}]`))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    // This fixture's actual body text is only ~190 non-whitespace characters —
    // genuinely below the "is this a scanned PDF" threshold, so `empty: true`
    // here is correct, not a bug. The "not empty" case is covered below with a
    // fixture that has enough real text.
    expect(result.empty).toBe(true)
  })

  it('extracts readable text from a real paper', async () => {
    const result = await extractPdfText(
      loadPdf('samples/pdfs/KeimKaplan_FromScatteredToStructured.pdf'),
    )
    expect(result.empty).toBe(false)
    expect(result.pages).toBeGreaterThan(1)
    expect(result.text).toContain('[page 1]')
    // Sanity check: the extracted text actually reads as English words, not
    // encoding soup, and covers more than just page 1.
    expect(result.text.toLowerCase()).toContain('abstract')
  })

  it('truncates to maxPages and notes the cut', async () => {
    const result = await extractPdfText(loadPdf('samples/pdfs/multipage.pdf'), { maxPages: 2 })
    expect(result.text).toContain('[page 1]')
    expect(result.text).toContain('[page 2]')
    expect(result.text).not.toContain('[page 3]')
    expect(result.text).not.toContain('[page 4]')
    // Total page count still reflects the real document, only the text is cut.
    expect(result.pages).toBe(4)
    expect(result.text).toMatch(/more page\(s\) omitted/)
  })

  it('is not empty for a normal text PDF', async () => {
    const result = await extractPdfText(loadPdf('samples/pdfs/paper-a.pdf'))
    expect(result.empty).toBe(false)
    expect(result.text.replace(/\s/g, '').length).toBeGreaterThan(200)
  })

  it('collapses excessive blank lines so the prompt stays compact', async () => {
    const result = await extractPdfText(loadPdf('samples/pdfs/multipage.pdf'))
    expect(result.text).not.toMatch(/\n{3,}/)
  })

  it('flags a page with no text layer at all as empty', async () => {
    // A minimal, hand-built single-page PDF with a Resources dict but no
    // content stream — the page has geometry and nothing else, the way a
    // scanned page (image only, no OCR text layer) would look to pdf.js.
    const blankPdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>>>endobj
trailer<</Size 4/Root 1 0 R>>
%%EOF`
    const data = new Uint8Array(new TextEncoder().encode(blankPdf)).buffer
    const result = await extractPdfText(data)
    expect(result.pages).toBe(1)
    expect(result.empty).toBe(true)
    expect(result.text).toBe('[page 1]')
  })

  it('flags a MANY-page no-text-layer PDF as empty (markers must not count as content)', async () => {
    // Regression: `empty` counted the whole assembled text, including one
    // `[page N]` marker per page (~7 non-whitespace chars each). A ~30-page
    // scanned/image-only PDF therefore crossed the "has text" threshold on its
    // markers alone and read as non-empty — defeating the AI flow's guard
    // against feeding an image-only PDF to the model. `empty` must reflect the
    // extracted *body* text only.
    const N = 30
    const objs: string[] = []
    objs.push('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj')
    const kids = Array.from({ length: N }, (_, i) => `${i + 3} 0 R`).join(' ')
    objs.push(`2 0 obj<</Type/Pages/Kids[${kids}]/Count ${N}>>endobj`)
    for (let i = 0; i < N; i++) {
      objs.push(
        `${i + 3} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>>>endobj`,
      )
    }
    const pdf = `%PDF-1.4\n${objs.join('\n')}\ntrailer<</Size ${N + 3}/Root 1 0 R>>\n%%EOF`
    const data = new Uint8Array(new TextEncoder().encode(pdf)).buffer
    const result = await extractPdfText(data)
    expect(result.pages).toBe(N)
    expect(result.empty).toBe(true)
  })
})
