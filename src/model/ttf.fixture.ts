// A tiny hand-built TrueType font for the PDF font tests.
const u16 = (...v: number[]) => v.flatMap((x) => [(x >> 8) & 0xff, x & 0xff])
const u32 = (...v: number[]) => v.flatMap((x) => [(x >>> 24) & 0xff, (x >> 16) & 0xff, (x >> 8) & 0xff, x & 0xff])
const pad = (bytes: number[], size: number) => [...bytes, ...new Array(Math.max(0, size - bytes.length)).fill(0)]

/** Five glyphs of 12 bytes each, except glyph 3, a composite of glyph 2 (16 bytes).  The last byte of a simple glyph is its id. */
const GLYF = [0, 1, 2, 3, 4].flatMap((g) => (g === 3 ? [...u16(0xffff, 0, 0, 0, 0, 0, 2), ...u16(0)] : [...pad([0, 1], 11), g]))

/** A tiny TrueType font: A-C map to glyphs 1-3 (format 4), U+4E2D to glyph 4 (format 12); glyph 0 is 500 wide, the others 600. */
export function tinyFont(opts: { fsType?: number; version?: number; format12?: boolean } = {}): Uint8Array {
  const format4 = [...u16(4, 32, 0, 4, 4, 1, 0), ...u16(0x43, 0xffff), ...u16(0), ...u16(0x41, 0xffff), ...u16((1 - 0x41) & 0xffff, 1), ...u16(0, 0)]
  const format12 = [...u16(12, 0), ...u32(28, 0, 1, 0x4e2d, 0x4e2d, 4)]
  const records = opts.format12 === false ? [[3, 1, format4]] : [[3, 1, format4], [3, 10, format12]]
  const header = [...u16(0, records.length)]
  let at = 4 + records.length * 8
  const body: number[] = []
  for (const [platform, encoding, sub] of records as [number, number, number[]][]) {
    header.push(...u16(platform, encoding), ...u32(at))
    body.push(...sub)
    at += sub.length
  }
  const head = pad([], 54)
  head.splice(18, 2, ...u16(1000))
  head.splice(36, 8, ...u16(0xff9c, 0xff38, 900, 800))
  const hhea = pad([], 36)
  hhea.splice(4, 4, ...u16(800, 0xff38))
  hhea.splice(34, 2, ...u16(2))
  const tables: [string, number[]][] = [
    ['OS/2', pad(u16(), 78).map((b, i) => (i === 8 ? ((opts.fsType ?? 0) >> 8) & 0xff : i === 9 ? (opts.fsType ?? 0) & 0xff : b))],
    ['cmap', [...header, ...body]],
    ['glyf', GLYF],
    ['loca', u16(0, 6, 12, 18, 26, 32)],
    ['maxp', pad(u16(), 6).map((b, i) => (i === 5 ? 5 : b))],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', [...u16(500, 0, 600, 0)]],
  ]
  const out = [...u32(opts.version ?? 0x00010000), ...u16(tables.length, 0, 0, 0)]
  let offset = 12 + tables.length * 16
  for (const [tag, data] of tables) {
    out.push(...[...tag].map((c) => c.charCodeAt(0)), ...u32(0, offset, data.length))
    offset += data.length
  }
  for (const [, data] of tables) out.push(...data)
  return Uint8Array.from(out)
}
