/**
 * Pure coordinate math for burning `PdfMark`s into real PDF annotation
 * objects — the "export" counterpart to `pdfMarks.ts`'s in-app overlay (see
 * that file's doc comment for why the overlay itself never touches the PDF
 * binary). No pdf-lib dependency here on purpose: constructing the actual
 * annotation dictionaries needs Node `fs` + pdf-lib and lives in
 * electron/main.ts, the only place in this app that touches both; this file
 * stays pure math so it's trivially unit-testable without a real PDF.
 */
import type { MarkRect } from './pdfMarks'

/** A rect in PDF user-space points: bottom-left origin, y increasing upward. */
export interface PdfRectPoints {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Convert a `MarkRect` — a fraction (0..1) of the page's rendered box,
 * top-left origin, y-down — into PDF point space for a page of size
 * `pageWidth` x `pageHeight` points. `y` in the result is the rect's BOTTOM
 * edge (PDF's own convention for a `/Rect`'s `lly`), which is why the flip
 * subtracts the (already-scaled) height rather than just inverting `y`.
 */
export function rectToPdfPoints(rect: MarkRect, pageWidth: number, pageHeight: number): PdfRectPoints {
  const width = rect.width * pageWidth
  const height = rect.height * pageHeight
  const x = rect.x * pageWidth
  const y = pageHeight - rect.y * pageHeight - height
  return { x, y, width, height }
}

/**
 * PDF `/QuadPoints` for one `MarkRect` — 8 numbers, per the PDF spec
 * (§8.4.5): `x1 y1 x2 y2 x3 y3 x4 y4` = top-left, top-right, bottom-left,
 * bottom-right of the quadrilateral. That specific pairing (not a
 * clockwise/counterclockwise walk) is what viewers expect; getting it wrong
 * renders the highlight mirrored or skewed in some readers.
 */
export function rectToQuadPoints(rect: MarkRect, pageWidth: number, pageHeight: number): number[] {
  const { x, y, width, height } = rectToPdfPoints(rect, pageWidth, pageHeight)
  const top = y + height
  return [x, top, x + width, top, x, y, x + width, y]
}

/**
 * Derive an export file name from the original: `paper.pdf` →
 * `paper-annotated.pdf`. A name with no `.pdf` extension still gets one
 * (the export is always a PDF, regardless of what the source was named). A
 * name already ending in `-annotated` is left alone rather than
 * double-suffixed, so re-exporting an already-annotated export doesn't
 * produce `paper-annotated-annotated.pdf`.
 */
export function annotatedFileName(originalName: string): string {
  const m = /^(.*)\.pdf$/i.exec(originalName)
  const base = m ? m[1] : originalName
  if (/-annotated$/i.test(base)) return `${base}.pdf`
  return `${base}-annotated.pdf`
}
