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
