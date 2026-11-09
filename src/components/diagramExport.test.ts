// [utest->req~ui-370~1]
import { describe, it, expect } from 'vitest'
import { findPdfFont } from './diagramExport'
import { tinyFont } from '../model/ttf.fixture'

const fonts = (...list: (Uint8Array | null)[]) => async (i: number) => list[i] ?? null

describe('findPdfFont', () => {
  it('returns the first font that has every character', async () => {
    const wide = tinyFont()
    const narrow = tinyFont({ format12: false })
    expect(await findPdfFont(['中'], fonts(narrow, wide))).toEqual({ found: { font: wide } })
    expect(await findPdfFont(['A', '中'], fonts(wide, narrow))).toEqual({ found: { font: wide } })
  })

  it('says no font exists when the computer offers none, or none that parses', async () => {
    expect(await findPdfFont(['中'], fonts())).toEqual({ missing: ['中'], why: 'no-font' })
    expect(await findPdfFont(['中'], fonts(new Uint8Array(8)))).toEqual({ missing: ['中'], why: 'no-font' })
    expect(await findPdfFont(['中'], fonts(tinyFont({ fsType: 2 })))).toEqual({ missing: ['中'], why: 'no-font' })
  })

  it('names the characters that the best font still lacks', async () => {
    expect(await findPdfFont(['中', 'Z', 'Y'], fonts(tinyFont({ format12: false }), tinyFont()))).toEqual({ missing: ['Z', 'Y'], why: 'uncovered' })
  })

  it('never embeds characters that need text shaping', async () => {
    expect(await findPdfFont(['ب', '中'], fonts(tinyFont()))).toEqual({ missing: ['ب'], why: 'shaping' })
  })
})
