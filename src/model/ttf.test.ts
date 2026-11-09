// [utest->req~ui-370~1]
import { describe, expect, it } from 'vitest'
import { parseTrueType, subsetTrueType } from './ttf'

import { tinyFont } from './ttf.fixture'

describe('parseTrueType', () => {
  it('maps code points to glyphs through format 4 and format 12 subtables', () => {
    const font = parseTrueType(tinyFont())
    expect(font?.glyph(0x41)).toBe(1)
    expect(font?.glyph(0x43)).toBe(3)
    expect(font?.glyph(0x44)).toBe(0)
    expect(font?.glyph(0x4e2d)).toBe(4)
    expect(font?.glyph(0x4e2e)).toBe(0)
  })

  it('reads the metrics and repeats the last advance width for later glyphs', () => {
    const font = parseTrueType(tinyFont())
    expect(font).toMatchObject({ unitsPerEm: 1000, bbox: [-100, -200, 900, 800], ascent: 800, descent: -200 })
    expect([0, 1, 4].map((g) => font?.advance(g))).toEqual([500, 600, 600])
  })

  it('refuses fonts that are not TrueType, damaged, or licensed against embedding', () => {
    expect(parseTrueType(tinyFont({ version: 0x4f54544f }))).toBeNull()
    expect(parseTrueType(tinyFont({ fsType: 0x0002 }))).toBeNull()
    expect(parseTrueType(tinyFont({ fsType: 0x0004 }))).not.toBeNull()
    expect(parseTrueType(tinyFont().subarray(0, 40))).toBeNull()
    expect(parseTrueType(new Uint8Array(3))).toBeNull()
  })
})

describe('subsetTrueType', () => {
  const glyphBytes = (font: Uint8Array) => {
    const view = new DataView(font.buffer)
    const tables = new Map<string, [number, number]>()
    for (let i = 0; i < view.getUint16(4); i++) {
      const at = 12 + i * 16
      tables.set(String.fromCharCode(...font.subarray(at, at + 4)), [view.getUint32(at + 8), view.getUint32(at + 12)])
    }
    const [loca] = tables.get('loca')!
    const [glyf] = tables.get('glyf')!
    return (g: number) => font.subarray(glyf + view.getUint32(loca + g * 4), glyf + view.getUint32(loca + g * 4 + 4))
  }

  // [utest->req~ui-370~1]
  it('keeps the used glyphs and the glyphs of their composites, and empties the rest', () => {
    const subset = subsetTrueType(tinyFont(), [3])!
    const glyph = glyphBytes(subset)
    expect([0, 1, 2, 3, 4].map((g) => glyph(g).length)).toEqual([12, 0, 12, 16, 0])
    expect(glyph(2)[11]).toBe(2)
    expect(subset.length).toBeLessThan(tinyFont().length + 64)
  })

  // [utest->req~ui-370~1]
  it('keeps the glyph ids and the metrics of the kept glyphs, and drops tables a PDF does not need', () => {
    const subset = subsetTrueType(tinyFont(), [4])!
    const view = new DataView(subset.buffer)
    const tags = Array.from({ length: view.getUint16(4) }, (_, i) => String.fromCharCode(...subset.subarray(12 + i * 16, 16 + i * 16)))
    expect(tags).toEqual(['glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp'])
    expect(glyphBytes(subset)(4)[11]).toBe(4)
    expect(subsetTrueType(new Uint8Array(20), [1])).toBeNull()
  })
})
