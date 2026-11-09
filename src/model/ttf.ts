// [impl->req~ui-370~1]
export interface TrueTypeFont {
  unitsPerEm: number
  /** xMin, yMin, xMax, yMax in font units. */
  bbox: [number, number, number, number]
  ascent: number
  descent: number
  /** Glyph id of a code point; 0 if the font lacks it. */
  glyph(codePoint: number): number
  /** Advance width of a glyph in font units. */
  advance(glyph: number): number
}

/** `fsType` bits: 1 = restricted licence, 9 = bitmap embedding only. Both forbid embedding the outlines in a document. */
const NO_EMBEDDING = 0x0202

/** Reads a TrueType font file (glyf outlines) for embedding in a PDF. Null for CFF/OpenType, collections, damaged files and fonts whose licence forbids embedding. */
export function parseTrueType(bytes: Uint8Array): TrueTypeFont | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    const version = view.getUint32(0)
    if (version !== 0x00010000 && version !== 0x74727565) return null
    const tables = new Map<string, number>()
    for (let i = 0, count = view.getUint16(4); i < count; i++) {
      const at = 12 + i * 16
      const tag = String.fromCharCode(...bytes.subarray(at, at + 4))
      tables.set(tag, view.getUint32(at + 8))
    }
    const need = (tag: string) => {
      const at = tables.get(tag)
      if (at === undefined || at >= bytes.length) throw new Error(`No ${tag} table`)
      return at
    }
    need('glyf')
    const os2 = tables.get('OS/2')
    if (os2 !== undefined && view.getUint16(os2 + 8) & NO_EMBEDDING) return null
    const head = need('head')
    const hhea = need('hhea')
    const hmtx = need('hmtx')
    const cmap = need('cmap')
    const metrics = view.getUint16(hhea + 34)
    const lookups: ((cp: number) => number)[] = []
    for (let i = 0, count = view.getUint16(cmap + 2); i < count; i++) {
      const platform = view.getUint16(cmap + 4 + i * 8)
      const encoding = view.getUint16(cmap + 6 + i * 8)
      if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue
      const at = cmap + view.getUint32(cmap + 8 + i * 8)
      const format = view.getUint16(at)
      if (format === 4) lookups.push((cp) => lookup4(view, at, cp))
      else if (format === 12) lookups.push((cp) => lookup12(view, at, cp))
    }
    if (!lookups.length) return null
    return {
      unitsPerEm: view.getUint16(head + 18),
      bbox: [view.getInt16(head + 36), view.getInt16(head + 38), view.getInt16(head + 40), view.getInt16(head + 42)],
      ascent: view.getInt16(hhea + 4),
      descent: view.getInt16(hhea + 6),
      glyph: (cp) => {
        for (const find of lookups) {
          const g = find(cp)
          if (g) return g
        }
        return 0
      },
      advance: (g) => view.getUint16(hmtx + Math.min(g, metrics - 1) * 4),
    }
  } catch {
    return null
  }
}

function lookup4(view: DataView, at: number, cp: number): number {
  if (cp > 0xffff) return 0
  const segs = view.getUint16(at + 6) / 2
  const ends = at + 14
  const starts = ends + segs * 2 + 2
  const deltas = starts + segs * 2
  const offsets = deltas + segs * 2
  for (let s = 0; s < segs; s++) {
    if (view.getUint16(ends + s * 2) < cp) continue
    const start = view.getUint16(starts + s * 2)
    if (start > cp) return 0
    const delta = view.getUint16(deltas + s * 2)
    const range = view.getUint16(offsets + s * 2)
    if (!range) return (cp + delta) & 0xffff
    const g = view.getUint16(offsets + s * 2 + range + (cp - start) * 2)
    return g ? (g + delta) & 0xffff : 0
  }
  return 0
}

function lookup12(view: DataView, at: number, cp: number): number {
  for (let i = 0, groups = view.getUint32(at + 12); i < groups; i++) {
    const group = at + 16 + i * 12
    const start = view.getUint32(group)
    if (cp >= start && cp <= view.getUint32(group + 4)) return view.getUint32(group + 8) + cp - start
  }
  return 0
}

const KEPT_TABLES = ['cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'prep']
const up4 = (n: number) => (n + 3) & ~3

function checksum(bytes: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < bytes.length; i += 4) {
    sum = (sum + (((bytes[i] << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0)) >>> 0)) >>> 0
  }
  return sum
}

/**
 * A copy of a TrueType font that keeps the outlines of `glyphs` (and of the glyphs that composites among them use) and
 * gives every other glyph an empty outline. Glyph ids stay the same, so a PDF can keep its Identity glyph mapping. The
 * `cmap`, `name`, `OS/2` and `post` tables are dropped. Null if the font is damaged.
 */
export function subsetTrueType(bytes: Uint8Array, glyphs: Iterable<number>): Uint8Array | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const tables = new Map<string, Uint8Array>()
    for (let i = 0, count = view.getUint16(4); i < count; i++) {
      const at = 12 + i * 16
      const offset = view.getUint32(at + 8)
      const length = view.getUint32(at + 12)
      if (offset + length > bytes.length) return null
      tables.set(String.fromCharCode(...bytes.subarray(at, at + 4)), bytes.subarray(offset, offset + length))
    }
    const table = (tag: string) => {
      const t = tables.get(tag)
      if (!t) throw new Error(`No ${tag} table`)
      return t
    }
    const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
    const [head, hhea, maxp, loca, glyf, hmtx] = ['head', 'hhea', 'maxp', 'loca', 'glyf', 'hmtx'].map(table)
    const count = dv(maxp).getUint16(4)
    const long = dv(head).getInt16(50) === 1
    const locaView = dv(loca)
    const glyfView = dv(glyf)
    const start = (g: number) => (long ? locaView.getUint32(g * 4) : locaView.getUint16(g * 2) * 2)
    const used = new Set<number>()
    const add = (g: number) => {
      if (used.has(g) || g >= count) return
      used.add(g)
      const from = start(g)
      if (start(g + 1) - from < 10 || glyfView.getInt16(from) >= 0) return
      for (let at = from + 10; ; ) {
        const flags = glyfView.getUint16(at)
        add(glyfView.getUint16(at + 2))
        if (!(flags & 0x20)) break
        at += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0)
      }
    }
    add(0)
    for (const g of glyphs) add(g)

    const order = [...used].sort((a, b) => a - b)
    const newLoca = new DataView(new ArrayBuffer((count + 1) * 4))
    let size = 0
    for (let g = 0, next = 0; g <= count; g++) {
      newLoca.setUint32(g * 4, size)
      if (order[next] === g) {
        size += up4(start(g + 1) - start(g))
        next++
      }
    }
    const newGlyf = new Uint8Array(size)
    for (const g of order) newGlyf.set(glyf.subarray(start(g), start(g + 1)), newLoca.getUint32(g * 4))

    const metrics = dv(hhea).getUint16(34)
    const newHmtx = new Uint8Array(hmtx.length)
    for (const g of [...order, metrics - 1]) {
      const [from, length] = g < metrics ? [g * 4, 4] : [metrics * 4 + (g - metrics) * 2, 2]
      if (from + length <= hmtx.length) newHmtx.set(hmtx.subarray(from, from + length), from)
    }
    const newHead = Uint8Array.from(head)
    dv(newHead).setUint32(8, 0)
    dv(newHead).setInt16(50, 1)

    const out = new Map(tables)
    out.set('head', newHead).set('loca', new Uint8Array(newLoca.buffer)).set('glyf', newGlyf).set('hmtx', newHmtx)
    const tags = KEPT_TABLES.filter((t) => out.has(t))
    const entry = Math.floor(Math.log2(tags.length))
    const file = new Uint8Array(12 + tags.length * 16 + tags.reduce((sum, t) => sum + up4(out.get(t)!.length), 0))
    const fv = new DataView(file.buffer)
    fv.setUint32(0, 0x00010000)
    fv.setUint16(4, tags.length)
    fv.setUint16(6, 16 << entry)
    fv.setUint16(8, entry)
    fv.setUint16(10, tags.length * 16 - (16 << entry))
    let at = 12 + tags.length * 16
    tags.forEach((tag, i) => {
      const data = out.get(tag)!
      file.set(data, at)
      for (let c = 0; c < 4; c++) file[12 + i * 16 + c] = tag.charCodeAt(c)
      fv.setUint32(12 + i * 16 + 4, checksum(file.subarray(at, at + up4(data.length))))
      fv.setUint32(12 + i * 16 + 8, at)
      fv.setUint32(12 + i * 16 + 12, data.length)
      at += up4(data.length)
    })
    return file
  } catch {
    return null
  }
}
