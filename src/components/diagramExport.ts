// [impl->req~ui-320~1]
import { svgToVectorPdf, type PdfFont } from '../model/vectorPdf'
import { parseTrueType, subsetTrueType } from '../model/ttf'

export type DiagramFormat = 'svg' | 'png' | 'pdf'

async function raster(svg: string, width: number, height: number, scale: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No canvas')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The diagram as PNG bytes, at `scale` times its size. */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Uint8Array> {
  const canvas = await raster(svg, width, height, scale)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('No image')
  return new Uint8Array(await blob.arrayBuffer())
}

/** Text width in pixels in the font the preview uses; a rough estimate where there is no canvas. */
function measureText(text: string, size: number, bold: boolean): number {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return text.length * size * 0.58
  ctx.font = `${bold ? 'bold ' : ''}${size}px sans-serif`
  return ctx.measureText(text).width
}

/** Characters that need text shaping (Hebrew, Arabic, Indic and similar scripts); a PDF cannot set them one glyph per character. */
const SHAPED = /[\u0590-\u0dff\ufb1d-\ufefc]/

export type FontSearch =
  | { found: { font: Uint8Array } }
  | { missing: string[]; why: 'shaping' | 'no-font' | 'uncovered' }

/** The first installed font (as `read` gives them, by index) that has every one of `chars`; else why none can be embedded. */
export async function findPdfFont(chars: string[], read: (index: number) => Promise<Uint8Array | null>): Promise<FontSearch> {
  const shaped = chars.filter((ch) => SHAPED.test(ch))
  if (shaped.length) return { missing: shaped, why: 'shaping' }
  let best: string[] | undefined
  for (let i = 0; ; i++) {
    const bytes = await read(i)
    if (!bytes) break
    const ttf = parseTrueType(bytes)
    if (!ttf) continue
    const missing = chars.filter((ch) => !ttf.glyph(ch.codePointAt(0) ?? 0))
    if (!missing.length) return { found: { font: bytes } }
    if (!best || missing.length < best.length) best = missing
  }
  return best ? { missing: best, why: 'uncovered' } : { missing: chars, why: 'no-font' }
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The diagram as a one-page vector PDF. With `font` (a TrueType file), texts the PDF fonts lack are set in it; only the glyphs used are embedded. */
export async function svgToPdf(svg: string, font?: Uint8Array): Promise<Uint8Array> {
  const ttf = font && parseTrueType(font)
  if (!font || !ttf) return svgToVectorPdf(svg, measureText).pdf
  const probe: PdfFont = { ttf, file: new Uint8Array(), length: 0 }
  const used = svgToVectorPdf(svg, measureText, probe).glyphs
  const small = subsetTrueType(font, used) ?? font
  return svgToVectorPdf(svg, measureText, { ttf, file: await deflate(small), length: small.length }).pdf
}
