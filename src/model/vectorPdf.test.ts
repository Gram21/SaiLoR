import { describe, it, expect } from 'vitest'
import { nonWinAnsiChars, svgToVectorPdf, type PdfFont } from './vectorPdf'
import { parseTrueType } from './ttf'
import { tinyFont } from './ttf.fixture'
import { renderDiagram } from './diagramSvg'
import { DEFAULT_CONFIG, type DiagramConfig } from './diagram'

const measure = (s: string, size: number) => s.length * size * 0.5
const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b)
const cfg = (over: Partial<DiagramConfig> = {}): DiagramConfig => ({ ...DEFAULT_CONFIG, ...over })
const data = { cats: ['a', 'b'], series: ['x', 'y'], counts: [[1, 3], [2, 2]], papers: 8 }

describe('svgToVectorPdf', () => {
  // [utest->req~ui-370~1]
  it.each(['bar', 'stacked', 'line', 'pie', 'heatmap'] as const)('writes %s as vector graphics and text', (type) => {
    const c = cfg({ type, values: true, title: 'T (1)', xLabel: 'X', yLabel: 'Y' })
    const pdf = svgToVectorPdf(renderDiagram(data, c), measure).pdf
    const s = latin1(pdf)
    expect(s.startsWith('%PDF-1.4')).toBe(true)
    expect(s).toContain('(T \\(1\\)) Tj')
    expect(s).not.toContain('/Subtype /Image')
    const start = Number(/startxref\s+(\d+)/.exec(s)![1])
    const offsets = [...s.slice(start).matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]))
    offsets.forEach((o, i) => expect(s.slice(o, o + 7)).toBe(`${i + 1} 0 obj`))
  })

  // [utest->req~ui-370~1]
  it('turns rotated labels, arcs and transparency into PDF operators', () => {
    const s = latin1(svgToVectorPdf(renderDiagram(data, cfg({ type: 'heatmap', yLabel: 'Y' })), measure).pdf)
    expect(s).toMatch(/-?\d[\d.]* -?\d[\d.]* -?\d[\d.]* -?\d[\d.]* -?\d[\d.]* -?\d[\d.]* cm BT/)
    expect(s).toContain('/ca')
  })

  // [utest->req~ui-370~1]
  it('draws a character the fonts lack as ? and counts it, never an image', () => {
    const { pdf, replaced } = svgToVectorPdf(renderDiagram(data, cfg({ title: '日本' })), measure)
    expect(replaced).toBe(2)
    expect(latin1(pdf)).toContain('(??) Tj')
    expect(latin1(pdf)).not.toContain('/Subtype /Image')
    expect(svgToVectorPdf(renderDiagram(data, cfg()), measure).replaced).toBe(0)
  })

  it('throws for a document that is not an SVG', () => {
    expect(() => svgToVectorPdf('not svg', measure)).toThrow()
  })

  // [utest->req~ui-370~1]
  it('keeps Latin-1 letters as single bytes', () => {
    const s = latin1(svgToVectorPdf(renderDiagram(data, cfg({ title: 'Größe…' })), measure).pdf)
    expect(s).toContain('(Größe…) Tj')
  })

  const embedded = (): PdfFont => {
    const bytes = tinyFont()
    return { ttf: parseTrueType(bytes)!, file: bytes, length: bytes.length }
  }

  // [utest->req~ui-370~1]
  it('lists the characters the built-in fonts lack', () => {
    expect(nonWinAnsiChars(renderDiagram(data, cfg({ title: '日本 é 日' })))).toEqual(['日', '本'])
    expect(nonWinAnsiChars(renderDiagram(data, cfg()))).toEqual([])
  })

  // [utest->req~ui-370~1]
  it('embeds the font for a text with such a character and sets it as glyph ids', () => {
    const { pdf, replaced } = svgToVectorPdf(renderDiagram(data, cfg({ title: '中' })), measure, embedded())
    const s = latin1(pdf)
    expect(replaced).toBe(0)
    expect(s).toContain('<0004> Tj')
    expect(s).toContain('/Subtype /CIDFontType2')
    expect(s).toContain('/Encoding /Identity-H')
    expect(s).toContain('/W [4 [600]')
    expect(s).toMatch(/\/FontFile2 10 0 R/)
    expect(s).toMatch(/\/Filter \/FlateDecode \/Length1 \d+/)
    expect(s).toContain('/F3 7 0 R')
    expect(s).toContain('/F1 ')
    const start = Number(/startxref\s+(\d+)/.exec(s)![1])
    const offsets = [...s.slice(start).matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]))
    expect(offsets).toHaveLength(10)
    offsets.forEach((o, i) => expect(s.startsWith(`${i + 1} 0 obj`, o)).toBe(true))
  })

  // [utest->req~ui-370~1]
  it('adds no font objects when no text needs the font, and counts glyphs the font lacks', () => {
    const plain = latin1(svgToVectorPdf(renderDiagram(data, cfg()), measure, embedded()).pdf)
    expect(plain).not.toContain('CIDFontType2')
    expect(svgToVectorPdf(renderDiagram(data, cfg({ title: '本' })), measure, embedded()).replaced).toBe(1)
  })

  // [utest->req~ui-370~1]
  it.each([['normal', '/F1 '], ['bold', '/F2 ']])('sets the same WinAnsi characters in the built-in %s face', (weight, face) => {
    const latin = 'Äöüß é ñ ç € “quoted” – … ™ • ¼ © Š ž Œ ‰ † ‹'
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text x="1" y="9" font-weight="${weight}">${latin}</text></svg>`
    const { pdf, replaced } = svgToVectorPdf(svg, measure, embedded())
    expect(replaced).toBe(0)
    expect(latin1(pdf)).toContain(face)
    expect(latin1(pdf)).not.toContain('CIDFontType2')
    expect(nonWinAnsiChars(svg)).toEqual([])
    expect(nonWinAnsiChars(svg.replace(latin, 'α Ж 中 ŝ'))).toEqual(['α', 'Ж', '中', 'ŝ'])
  })
})
