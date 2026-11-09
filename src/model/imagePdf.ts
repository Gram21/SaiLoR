// [impl->req~ui-320~1]
export const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

/** A PDF object: plain text, or a stream with its dictionary entries (without /Length). */
export type PdfObject = string | { data: Uint8Array; dict: string }

/** A PDF file. `objects[0]` is object 1, the catalog. */
export function pdfDocument(objects: PdfObject[]): Uint8Array {
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let size = 0
  const put = (c: Uint8Array | string) => {
    const b = typeof c === 'string' ? latin1(c) : c
    chunks.push(b)
    size += b.length
  }
  put('%PDF-1.4\n')
  objects.forEach((o, i) => {
    offsets.push(size)
    if (typeof o === 'string') put(`${i + 1} 0 obj\n${o}\nendobj\n`)
    else {
      put(`${i + 1} 0 obj\n<< ${o.dict} /Length ${o.data.length} >>\nstream\n`)
      put(o.data)
      put('\nendstream\nendobj\n')
    }
  })
  const xref = size
  put(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`)
  put(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** A one-page PDF of `width` x `height` points that shows one RGB image, Flate-compressed, over the whole page. */
export function imagePdf(deflatedRgb: Uint8Array, pixelWidth: number, pixelHeight: number, width: number, height: number): Uint8Array {
  return pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    { data: latin1(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`), dict: '' },
    { data: deflatedRgb, dict: `/Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode` },
  ])
}
