// [utest->req~ui-370~1]
import { describe, expect, it } from 'vitest'
import { parseTrueType } from './ttf'

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
