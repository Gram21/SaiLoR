// [impl->req~ui-320~1]
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

/** A one-page PDF of `width` x `height` points that shows one RGB image, Flate-compressed, over the whole page. */
export function imagePdf(deflatedRgb: Uint8Array, pixelWidth: number, pixelHeight: number, width: number, height: number): Uint8Array {
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let size = 0
  const put = (c: Uint8Array | string) => {
    const b = typeof c === 'string' ? latin1(c) : c
    chunks.push(b)
    size += b.length
  }
  const object = (n: number, body: Uint8Array | string, dict?: string) => {
    offsets[n] = size
    if (dict === undefined) put(`${n} 0 obj\n${body}\nendobj\n`)
    else {
      put(`${n} 0 obj\n<< ${dict} /Length ${(body as Uint8Array).length} >>\nstream\n`)
      put(body)
      put('\nendstream\nendobj\n')
    }
  }
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`
  put('%PDF-1.4\n')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`)
  object(4, latin1(content), '')
  object(5, deflatedRgb, `/Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`)
  const xref = size
  put(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`)
  put(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
