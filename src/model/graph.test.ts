import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from './schema'
import type { AnnotationValueTree } from './annotations'
import type { Paper } from './project'
import {
  buildGraph,
  csvCell,
  graphSource,
  graphTrees,
  toCsvEdges,
  toCsvNodes,
  toGraphMl,
  toJsonLd,
  toTurtle,
  turtleString,
  xmlText,
} from './graph'

const SCHEMA = resolveSchema([
  { name: 'Relevant', type: 'boolean' },
  { name: 'Method', type: 'string', options: ['Survey', 'Experiment'] },
  { name: 'Note', type: 'string', visibleIf: 'Relevant' },
  { name: 'Tool', max: null, children: [{ name: 'Name', type: 'string' }, { name: 'Open', type: 'boolean' }] },
] satisfies AnnotationDef[])

function makePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: 'p1',
    title: 'Paper One',
    authors: [],
    pdf: 'p1.pdf',
    annotations: {},
    reviews: {},
    aiUsage: [],
    equal: [],
    alignment: {},
    marks: [],
    reviewMarks: {},
    finished: false,
    reviewsFinished: {},
    extra: {},
    ...overrides,
  }
}

const ANSWERS: AnnotationValueTree = {
  Relevant: [{ value: true }],
  Method: [{ value: 'Survey' }],
  Note: [{ value: 'see appendix' }],
  Tool: [
    { children: { Name: [{ value: 'Ant' }], Open: [{ value: true }] } },
    { children: { Name: [{ value: '' }], Open: [{ value: false }] } },
  ],
  Gone: [{ value: 'orphan' }],
}

const PAPERS = [
  makePaper({
    id: 'p1',
    title: 'Paper One',
    authors: ['Ada  Lovelace', 'Alan Turing'],
    venue: 'ICSE',
    year: 2020,
    doi: '10.1/one',
    extra: { keywords: 'graphs; Testing', references: ['https://doi.org/10.1/TWO', 'unknown'] },
  }),
  makePaper({ id: 'p2', title: 'Paper Two', authors: ['ada lovelace'], venue: 'icse', doi: '10.1/two', extra: { keywords: ['testing'] } }),
]

const project = { schema: SCHEMA, papers: PAPERS }

describe('buildGraph', () => {
  // [utest->req~dat-480~1]
  it('makes metadata nodes and merges names that differ in case or spaces', () => {
    const g = buildGraph(project, {})
    expect(g.nodes.map((n) => n.id)).toEqual([
      'author:ada lovelace',
      'author:alan turing',
      'keyword:graphs',
      'keyword:testing',
      'paper:p1',
      'paper:p2',
      'venue:icse',
    ])
    expect(g.nodes.find((n) => n.id === 'author:ada lovelace')?.label).toBe('Ada Lovelace')
    expect(g.nodes.find((n) => n.id === 'paper:p1')).toMatchObject({ type: 'Paper', label: 'Paper One', year: 2020, doi: '10.1/one' })
    expect(g.edges.filter((e) => e.source === 'paper:p1').map((e) => [e.type, e.target])).toEqual([
      ['authoredBy', 'author:ada lovelace'],
      ['authoredBy', 'author:alan turing'],
      ['cites', 'paper:p2'],
      ['hasKeyword', 'keyword:graphs'],
      ['hasKeyword', 'keyword:testing'],
      ['publishedIn', 'venue:icse'],
    ])
  })

  // [utest->req~dat-480~1]
  it('makes choice nodes, entry nodes and values, and skips empty, false, hidden and orphan data', () => {
    const g = buildGraph(project, { p1: ANSWERS, p2: { Relevant: [{ value: false }], Method: [{ value: 'Survey' }], Note: [{ value: 'hidden' }] } })
    const ids = g.nodes.map((n) => n.id)
    expect(ids).toContain('choice:Relevant=true')
    expect(ids).toContain('choice:Method=Survey')
    expect(ids).toContain('choice:Tool/Open=true')
    expect(ids).toContain('answer:p1/Tool#0')
    expect(ids).not.toContain('answer:p1/Tool#1')
    expect(ids.some((id) => id.includes('Gone') || id.includes('orphan'))).toBe(false)
    expect(g.nodes.find((n) => n.id === 'paper:p1')?.values).toEqual({ Note: ['see appendix'] })
    expect(g.nodes.find((n) => n.id === 'paper:p2')?.values).toEqual({})
    expect(g.nodes.find((n) => n.id === 'answer:p1/Tool#0')).toMatchObject({ type: 'Answer', field: 'Tool', values: { 'Tool/Name': ['Ant'] } })
    expect(g.edges).toContainEqual({ source: 'paper:p1', target: 'answer:p1/Tool#0', type: 'hasAnswer', field: 'Tool' })
    expect(g.edges).toContainEqual({ source: 'answer:p1/Tool#0', target: 'choice:Tool/Open=true', type: 'hasAnswer', field: 'Tool/Open' })
    expect(g.edges.filter((e) => e.target === 'choice:Method=Survey').map((e) => e.source)).toEqual(['paper:p1', 'paper:p2'])
  })

  // [utest->req~dat-480~1]
  it('gives the same result for the same input', () => {
    const trees = { p1: ANSWERS }
    expect(buildGraph(project, trees)).toEqual(buildGraph(project, trees))
    expect(buildGraph({ schema: SCHEMA, papers: [...PAPERS].reverse() }, trees)).toEqual(buildGraph(project, trees))
  })
})

describe('graphSource', () => {
  const seatTrees = { '1': { Method: [{ value: 'Survey' }] }, '2': { Method: [{ value: 'Experiment' }] } }

  // [utest->req~dat-490~1]
  it('uses the consolidated tree when one paper has a consolidated answer', () => {
    const papers = [makePaper({ annotations: { Method: [{ value: 'Survey' }] }, reviews: seatTrees })]
    const p = { reviewers: 2, schema: SCHEMA, papers }
    expect(graphSource(p)).toBe('consolidated')
    expect(graphTrees(p, '2').p1).toEqual({ Method: [{ value: 'Survey' }] })
  })

  // [utest->req~dat-490~1]
  it('uses the selected seat when no consolidated answer exists', () => {
    const p = { reviewers: 2, schema: SCHEMA, papers: [makePaper({ annotations: { Relevant: [{ value: false }] }, reviews: seatTrees })] }
    expect(graphSource(p)).toBe('seat')
    expect(graphTrees(p, '2').p1).toEqual({ Method: [{ value: 'Experiment' }] })
    expect(graphTrees(p, '3').p1).toEqual({})
  })

  // [utest->req~dat-490~1]
  it('uses the single tree with one reviewer and ignores seat metadata overrides', () => {
    const paper = makePaper({ title: 'Original', extra: { metadataOverrides: { title: 'Changed' } } })
    const p = { reviewers: 1, schema: SCHEMA, papers: [paper] }
    expect(graphSource(p)).toBe('consolidated')
    expect(buildGraph(p, graphTrees(p, '1')).nodes[0].label).toBe('Original')
  })
})

describe('graph formats', () => {
  const g = buildGraph(project, { p1: ANSWERS })

  // [utest->req~dat-500~1]
  it('writes JSON-LD with schema.org, Dublin Core and sailor terms', () => {
    const doc = JSON.parse(toJsonLd(g))
    expect(doc['@context'].sailor).toBe('https://github.com/Gram21/SaiLoR/ns#')
    const paper = doc['@graph'].find((n: { '@id': string }) => n['@id'] === 'urn:sailor:paper:p1')
    expect(paper['@type']).toEqual(['schema:ScholarlyArticle'])
    expect(paper['dcterms:title']).toEqual(['Paper One'])
    expect(paper['dcterms:issued']).toEqual([{ '@value': '2020', '@type': 'xsd:gYear' }])
    expect(paper['dcterms:creator']).toContainEqual({ '@id': 'urn:sailor:author:ada%20lovelace' })
    expect(paper['https://github.com/Gram21/SaiLoR/ns#field/Method']).toEqual([{ '@id': 'urn:sailor:choice:Method%3DSurvey' }])
    const field = doc['@graph'].find((n: { '@id': string }) => n['@id'] === 'https://github.com/Gram21/SaiLoR/ns#field/Tool%2FName')
    expect(field['rdfs:subPropertyOf']).toEqual([{ '@id': 'sailor:hasAnswer' }])
  })

  // [utest->req~dat-500~1]
  it('writes Turtle with prefixes and one block per subject', () => {
    const ttl = toTurtle(g)
    expect(ttl).toContain('@prefix sailor: <https://github.com/Gram21/SaiLoR/ns#> .')
    expect(ttl).toContain('<urn:sailor:paper:p1> a schema:ScholarlyArticle ;\n    dcterms:title "Paper One" ;')
    expect(ttl).toContain('dcterms:issued "2020"^^xsd:gYear')
    expect(ttl).toContain('<https://github.com/Gram21/SaiLoR/ns#field/Note> "see appendix"')
    expect(ttl.trimEnd().endsWith(' .')).toBe(true)
  })

  // [utest->req~dat-500~1]
  it('writes GraphML and CSV node and edge lists', () => {
    const xml = toGraphMl(g)
    expect(xml).toContain('<graph id="G" edgedefault="directed">')
    expect(xml).toContain('<key id="v0" for="node" attr.name="Note" attr.type="string"/>')
    expect(xml).toContain('<edge source="paper:p1" target="venue:icse">')
    const nodes = toCsvNodes(g).split('\r\n')
    expect(nodes[0]).toBe('"id","type","label","field","doi","year","abstract","Note","Tool/Name"')
    expect(nodes).toContain('"paper:p1","Paper","Paper One","","10.1/one","2020","","see appendix",""')
    expect(toCsvEdges(g).split('\r\n')).toContain('"paper:p1","answer:p1/Tool#0","hasAnswer","Tool"')
  })

  // [utest->req~dat-500~1]
  it('writes the same text for the same graph', () => {
    const again = buildGraph(project, { p1: ANSWERS })
    for (const f of [toJsonLd, toTurtle, toGraphMl, toCsvNodes, toCsvEdges]) expect(f(again)).toBe(f(g))
  })
})

describe('graph escaping', () => {
  const nasty = 'a"b\\c\nd\re\tf\u0001<&>\'\uFFFE'

  // [utest->req~dat-510~1]
  it('escapes Turtle strings and percent-encodes IRIs', () => {
    expect(turtleString(nasty)).toBe('"a\\"b\\\\c\\nd\\re\\tf\\u0001<&>\'\uFFFE"')
    const g = buildGraph({ schema: SCHEMA, papers: [makePaper({ id: 'p 1>', title: nasty })] }, {})
    const ttl = toTurtle(g)
    expect(ttl).toContain('<urn:sailor:paper:p%201%3E>')
    expect(ttl).not.toContain('\n"')
  })

  // [utest->req~dat-510~1]
  it('escapes XML and removes characters XML does not allow', () => {
    expect(xmlText(nasty)).toBe('a&quot;b\\c\nd\re\tf&lt;&amp;&gt;&apos;')
    expect(xmlText('ok \u{1F600} \uD800')).toBe('ok \u{1F600} ')
  })

  // [utest->req~dat-510~1]
  it('quotes CSV cells and guards formula starts', () => {
    expect(csvCell('a"b')).toBe('"a""b"')
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(s)).toBe(`"'${s}"`)
    expect(csvCell('plain, text')).toBe('"plain, text"')
    const g = buildGraph({ schema: SCHEMA, papers: [makePaper({ title: '=HYPERLINK("x")' })] }, {})
    expect(toCsvNodes(g)).toContain('"\'=HYPERLINK(""x"")"')
  })
})
