import { describe, it, expect } from 'vitest'
import { svgToVectorPdf } from './vectorPdf'
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
})
