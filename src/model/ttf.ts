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
