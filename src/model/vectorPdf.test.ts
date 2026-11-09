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
    const pdf = svgToVectorPdf(renderDiagram(data, c), measure)!
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
    const s = latin1(svgToVectorPdf(renderDiagram(data, cfg({ type: 'heatmap', yLabel: 'Y' })), measure)!)
    expect(s).toMatch(/-?\d[\d.]* -?\d[\d.]* -?\d[\d.]* -?\d[\d.]* -?\d[\d.]* -?\d[\d.]* cm BT/)
    expect(s).toContain('/ca')
  })

  // [utest->req~ui-370~1]
  it('returns null for text the built-in fonts cannot show', () => {
    expect(svgToVectorPdf(renderDiagram(data, cfg({ title: '日本語' })), measure)).toBeNull()
    expect(svgToVectorPdf('not svg', measure)).toBeNull()
  })

  // [utest->req~ui-370~1]
  it('keeps Latin-1 letters as single bytes', () => {
    const s = latin1(svgToVectorPdf(renderDiagram(data, cfg({ title: 'Größe…' })), measure)!)
    expect(s).toContain('(Größe…) Tj')
  })
})
