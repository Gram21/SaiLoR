import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from './schema'
import type { AnnotationValueTree } from './annotations'
import type { Paper } from './project'
import { buildGraph } from './graph'
import { aggregate, diagramCsv, diagramHost, schemaDimensions, paperValues, DEFAULT_CONFIG, OTHER, NONE, type DiagramConfig, type DiagramReply } from './diagram'
import { renderDiagram, niceStep } from './diagramSvg'
import { imagePdf } from './imagePdf'

const SCHEMA = resolveSchema([
  { name: 'Method', type: 'string', options: ['Survey', 'Experiment'] },
  { name: 'Tool', max: null, children: [{ name: 'Name', type: 'string' }] },
] satisfies AnnotationDef[])

const paper = (id: string, over: Partial<Paper> = {}): Paper =>
  ({ id, title: id, authors: [], pdf: `${id}.pdf`, annotations: {}, reviews: {}, aiUsage: [], equal: [], alignment: {}, marks: [], reviewMarks: {}, finished: false, reviewsFinished: {}, extra: {}, ...over }) as Paper

const PAPERS = [
  paper('a', { year: 2019, venue: 'ICSE' }),
  paper('b', { year: 2020, venue: 'ICSE' }),
  paper('c', { year: 2020, venue: 'FSE' }),
  paper('d', { venue: 'FSE' }),
]
const tree = (method?: string): AnnotationValueTree => (method ? { Method: [{ value: method }] } : {})
const trees = { a: tree('Survey'), b: tree('Survey'), c: tree('Experiment'), d: tree() }
const project = { schema: SCHEMA, papers: PAPERS }
const graph = buildGraph(project, trees)
const cfg = (over: Partial<DiagramConfig> = {}): DiagramConfig => ({ ...DEFAULT_CONFIG, ...over })

describe('diagram data', () => {
  // [utest->req~ui-290~1]
  it('lists schema fields by path', () => {
    expect(schemaDimensions(SCHEMA).map((d) => d.label)).toEqual(['Method', 'Tool › Name'])
  })

  // [utest->req~ui-290~1]
  it('counts papers per year and skips papers without a value', () => {
    const d = aggregate(graph, cfg())
    expect(d.cats).toEqual(['2019', '2020'])
    expect(d.counts).toEqual([[1], [2]])
    expect(d.papers).toBe(3)
  })

  // [utest->req~ui-290~1]
  it('counts the empty value when asked', () => {
    const d = aggregate(graph, cfg({ empty: true }))
    expect(d.cats).toContain(NONE)
    expect(d.papers).toBe(4)
  })

  // [utest->req~ui-290~1]
  it('reads a schema field and groups by venue', () => {
    const id = schemaDimensions(SCHEMA)[0].id
    expect(paperValues(graph, id).get('paper:a')).toEqual(['Survey'])
    const d = aggregate(graph, cfg({ x: id, group: '@venue' }))
    expect(d.cats).toEqual(['Experiment', 'Survey'])
    expect(d.series).toEqual(['FSE', 'ICSE'])
    expect(d.counts).toEqual([[1, 0], [0, 2]])
  })

  // [utest->req~ui-290~1]
  it('sorts by count and merges the rest into Other', () => {
    const d = aggregate(graph, cfg({ x: '@venue', sort: 'count', limit: 1 }))
    expect(d.cats).toEqual(['FSE', OTHER])
    const e = aggregate(graph, cfg({ x: '@year', sort: 'count', limit: 1 }))
    expect(e.cats).toEqual(['2020', OTHER])
    expect(e.counts).toEqual([[2], [1]])
  })
})

describe('renderDiagram', () => {
  // [utest->req~ui-300~1]
  it.each(['bar', 'stacked', 'line', 'pie', 'heatmap'] as const)('renders %s as standalone svg', (type) => {
    const c = cfg({ type, group: '@venue', title: 'T' })
    const svg = renderDiagram(aggregate(graph, c), c)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
    expect(svg).toContain('>T</text>')
  })

  // [utest->req~ui-300~1]
  it.each(['bar', 'stacked', 'line', 'pie', 'heatmap'] as const)('makes well-formed XML for %s with values and groups', (type) => {
    for (const group of ['', '@venue']) {
      const c = cfg({ type, group, values: true, title: 'A & B', xLabel: 'x', yLabel: 'y' })
      const doc = new DOMParser().parseFromString(renderDiagram(aggregate(graph, c), c), 'image/svg+xml')
      expect(doc.querySelector('parsererror')?.textContent).toBeUndefined()
    }
  })

  // [utest->req~ui-300~1]
  it('escapes markup in the title and labels and applies colours', () => {
    const c = cfg({ title: '<b>"x" & y</b>', xLabel: 'A<', colors: { '': '#123456' } })
    const svg = renderDiagram(aggregate(graph, c), c)
    expect(svg).not.toContain('<b>')
    expect(svg).toContain('&lt;b&gt;')
    expect(svg).toContain('#123456')
  })

  // [utest->req~ui-300~1]
  it('renders an empty diagram', () => {
    const svg = renderDiagram({ cats: [], series: [''], counts: [], papers: 0 }, cfg())
    expect(svg).toContain('</svg>')
  })

  it('picks 1-2-5 tick steps', () => {
    expect(niceStep(7, 6)).toBe(2)
    expect(niceStep(100, 5)).toBe(20)
    expect(niceStep(0, 6)).toBe(0.2)
  })
})

describe('diagramHost', () => {
  // [utest->req~ui-310~1]
  it('builds once and replies per render, with an error before data', () => {
    const out: DiagramReply[] = []
    const host = diagramHost((r) => out.push(r))
    host({ type: 'render', id: 1, config: cfg() })
    expect(out[0]).toMatchObject({ id: 1, error: expect.stringContaining('No data') })
    host({ type: 'data', project, trees })
    host({ type: 'render', id: 2, config: cfg() })
    expect(out[1]).toMatchObject({ id: 2, categories: 2, papers: 3 })
  })
})

describe('imagePdf', () => {
  // [utest->req~ui-320~1]
  it('writes a PDF whose xref offsets point at the objects', () => {
    const bytes = imagePdf(new Uint8Array([1, 2, 3]), 10, 10, 7.5, 7.5)
    const s = new TextDecoder('latin1').decode(bytes)
    expect(s.startsWith('%PDF-1.')).toBe(true)
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true)
    const start = Number(/startxref\s+(\d+)/.exec(s)![1])
    expect(s.slice(start, start + 4)).toBe('xref')
    const offsets = [...s.slice(start).matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]))
    offsets.forEach((o, i) => expect(s.slice(o, o + 7)).toBe(`${i + 1} 0 obj`))
  })
})

describe('diagram axis', () => {
  // [utest->req~ui-300~1]
  it('uses whole-number ticks for small counts', () => {
    const svg = renderDiagram({ cats: ['a', 'b'], series: [''], counts: [[1], [1]], papers: 2 }, cfg())
    const ticks = [...svg.matchAll(/text-anchor="end"[^>]*>([^<]*)</g)].map((m) => m[1])
    expect(ticks).toEqual(['0', '1'])
  })

  // [utest->req~ui-300~1]
  it('keeps heat map row labels clear of the axis title', () => {
    const c = cfg({ type: 'heatmap', yLabel: 'Papers' })
    const svg = renderDiagram({ cats: ['a', 'b'], series: [''], counts: [[1], [1]], papers: 2 }, c)
    expect(svg).toContain('>Papers<')
    expect(svg).not.toContain('…<')
  })
})

describe('diagram options', () => {
  const grouped = { cats: ['a', 'b'], series: ['x', 'y'], counts: [[1, 3], [2, 2]], papers: 8 }
  const wellFormed = (svg: string) => expect(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror')).toBeNull()

  // [utest->req~ui-330~1]
  it('keeps only the papers whose filter dimension contains the text', () => {
    const d = aggregate(graph, cfg({ filterDim: '@venue', filterText: ' icse ' }))
    expect(d.cats).toEqual(['2019', '2020'])
    expect(d.counts).toEqual([[1], [1]])
    expect(d.papers).toBe(2)
    expect(aggregate(graph, cfg({ filterDim: '@venue', filterText: '' })).papers).toBe(3)
    expect(aggregate(graph, cfg({ filterDim: '@venue', filterText: 'nothing' })).papers).toBe(0)
  })

  // [utest->req~ui-330~1]
  it('draws horizontal bars with the category names on the left', () => {
    for (const type of ['bar', 'stacked'] as const) {
      const svg = renderDiagram(grouped, cfg({ type, horizontal: true, xLabel: 'Venue', yLabel: 'Papers' }))
      wellFormed(svg)
      expect(svg).toMatch(/text-anchor="end"[^>]*>a</)
      expect(svg).toContain('rotate(-90')
      expect(svg.match(/<rect /g)!.length).toBe(1 + 2 + 4)
    }
  })

  // [utest->req~ui-330~1]
  it('shows stacked bars as shares of 100 percent', () => {
    for (const horizontal of [false, true]) {
      const svg = renderDiagram(grouped, cfg({ type: 'stacked', percent: true, horizontal }))
      wellFormed(svg)
      expect(svg).toContain('100%')
      expect(svg).toContain('25%')
      expect(svg).toContain('75%')
      expect(svg).toContain('a / y: 3 (75%)')
    }
  })

  // [utest->req~ui-340~1]
  it('writes the counts as CSV and neutralises formulas', () => {
    expect(diagramCsv(grouped, 'Venue', 'Papers')).toBe('"Venue","x","y"\r\n"a","1","3"\r\n"b","2","2"\r\n')
    expect(diagramCsv({ cats: ['=1+1'], series: [''], counts: [[2]], papers: 2 }, 'X', 'Papers')).toBe('"X","Papers"\r\n"\'=1+1","2"\r\n')
  })

  // [utest->req~ui-340~1]
  it('returns the data with the diagram', () => {
    const out: DiagramReply[] = []
    const host = diagramHost((r) => out.push(r))
    host({ type: 'data', project, trees })
    host({ type: 'render', id: 1, config: cfg() })
    expect(out[0]).toMatchObject({ data: { cats: ['2019', '2020'], counts: [[1], [2]] } })
  })
})
