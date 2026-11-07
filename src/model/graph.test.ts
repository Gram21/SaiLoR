import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from './schema'
import type { AnnotationValueTree } from './annotations'
import type { Paper } from './project'
import {
  buildGraph,
  csvCell,
  CONSOLIDATION,
  defaultGraphSeat,
  graphSeats,
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

describe('buildGraph — edge cases', () => {
  const citesOf = (g: ReturnType<typeof buildGraph>, id: string) =>
    g.edges.filter((e) => e.type === 'cites' && e.source === id).map((e) => e.target)

  // [utest->req~dat-480~1]
  it('resolves citations by id or by any DOI form, but never to itself or through a blank DOI', () => {
    const g = buildGraph(
      {
        schema: [],
        papers: [
          makePaper({ id: 'a', doi: '10.1/a', extra: { cites: ['doi:10.1/b', ' c ', 'HTTP://DX.DOI.ORG/10.1/A', '', 5] } }),
          makePaper({ id: 'b', doi: '10.1/b', extra: { references: 'http://dx.doi.org/10.1/a' } }),
          makePaper({ id: 'c', doi: '  ' }),
        ],
      },
      {},
    )
    expect(citesOf(g, 'paper:a')).toEqual(['paper:b', 'paper:c'])
    expect(citesOf(g, 'paper:b')).toEqual(['paper:a'])
  })

  // [utest->req~dat-480~1]
  it('splits keywords on commas and semicolons and drops blank venues, names and keywords', () => {
    const g = buildGraph(
      { schema: [], papers: [makePaper({ authors: [' ', 'Bo'], venue: '  ', extra: { keywords: ['x,y', 7, ' ; z'] } })] },
      {},
    )
    expect(g.nodes.map((n) => n.id)).toEqual(['author:bo', 'keyword:x', 'keyword:y', 'keyword:z', 'paper:p1'])
    expect(g.edges.map((e) => e.target)).toEqual(['author:bo', 'keyword:x', 'keyword:y', 'keyword:z'])
    expect(g.edges[0]).toStrictEqual({ source: 'paper:p1', target: 'author:bo', type: 'authoredBy' })
  })

  // [utest->req~dat-480~1]
  it('keeps the smallest label of names that merge', () => {
    const g = buildGraph({ schema: [], papers: [makePaper({ authors: ['bo', 'BO', 'Bo'] })] }, {})
    expect(g.nodes.find((n) => n.id === 'author:bo')?.label).toBe('BO')
  })

  // [utest->req~dat-480~1]
  it('copies paper year 0 but not a blank DOI or abstract', () => {
    const g = buildGraph({ schema: [], papers: [makePaper({ year: 0, doi: '', abstract: '' })] }, {})
    expect(g.nodes[0]).toEqual({ id: 'paper:p1', type: 'Paper', label: 'Paper One', year: 0, values: {} })
    const noYear = buildGraph({ schema: [], papers: [makePaper()] }, {})
    expect(noYear.nodes[0]).toStrictEqual({ id: 'paper:p1', type: 'Paper', label: 'Paper One', values: {} })
  })

  // [utest->req~dat-480~1]
  it('treats a string with no options as a value, and numbers as text', () => {
    const schema = resolveSchema([
      { name: 'S', type: 'string', options: [] },
      { name: 'N', type: 'number' },
    ])
    const g = buildGraph({ schema, papers: [makePaper()] }, { p1: { S: [{ value: 'x' }], N: [{ value: 0 }] } })
    expect(g.nodes[0].values).toEqual({ S: ['x'], N: ['0'] })
    expect(g.edges).toEqual([])
  })

  // [utest->req~dat-480~1]
  it('skips malformed entries and children and gates a child on its parent answer', () => {
    const schema = resolveSchema([
      { name: 'Uses', type: 'boolean', children: [{ name: 'Which', type: 'string', visibleIf: 'Uses' }] },
      { name: 'Tool', max: null, children: [{ name: 'Name', type: 'string' }] },
    ])
    const trees = {
      p1: {
        Uses: [{ value: false, children: { Which: [{ value: 'hidden' }] } }],
        Tool: [null, 'x', { children: 'bad' }, { children: { Name: [{ value: 'Ant' }] } }, {}, { children: null }],
      },
    } as unknown as Record<string, AnnotationValueTree>
    const g = buildGraph({ schema, papers: [makePaper()] }, trees)
    expect(g.nodes.map((n) => n.id)).toEqual(['answer:p1/Tool#3', 'paper:p1'])
    expect(g.nodes[0].label).toBe('Tool 4')
    expect(g.nodes[0].values).toEqual({ 'Tool/Name': ['Ant'] })
    const shown = buildGraph({ schema, papers: [makePaper()] }, { p1: { Uses: [{ value: true, children: { Which: [{ value: 'w' }] } }] } })
    expect(shown.nodes.map((n) => [n.id, n.values])).toEqual([
      ['answer:p1/Uses#0', { 'Uses/Which': ['w'] }],
      ['choice:Uses=true', {}],
      ['paper:p1', {}],
    ])
  })

  // [utest->req~dat-480~1]
  it('gates each child on the answer of its own parent entry', () => {
    const schema = resolveSchema([
      { name: 'Uses', type: 'boolean', max: null, children: [{ name: 'Which', type: 'string', visibleIf: 'Uses' }] },
    ])
    const tree = { Uses: [{ value: true, children: { Which: [{ value: 'w1' }] } }, { value: false, children: { Which: [{ value: 'w2' }] } }] }
    const g = buildGraph({ schema, papers: [makePaper()] }, { p1: tree })
    expect(g.nodes.filter((n) => n.type === 'Answer').map((n) => [n.id, n.values])).toEqual([['answer:p1/Uses#0', { 'Uses/Which': ['w1'] }]])
  })

  // [utest->req~dat-480~1]
  it('strips a DOI prefix only at the start', () => {
    const g = buildGraph(
      { schema: [], papers: [makePaper({ id: 'a', doi: '10.1/x' }), makePaper({ id: 'b', extra: { cites: ['10.1/doi:x'] } })] },
      {},
    )
    expect(g.edges).toEqual([])
  })
})

describe('graph source — edge cases', () => {
  // [utest->req~dat-490~1]
  it('uses the consolidated tree with zero reviewers and reads a missing tree as empty', () => {
    const p = { reviewers: 0, schema: SCHEMA, papers: [makePaper({ annotations: undefined as never })] }
    expect(graphSeats(p)).toEqual([])
    expect(graphTrees(p, '1')).toEqual({ p1: {} })
  })

  // [utest->req~dat-490~1]
  it('offers the consolidation when any one of several papers has a consolidated answer', () => {
    const papers = [makePaper({ id: 'p1', annotations: { Method: [{ value: 'Survey' }] } }), makePaper({ id: 'p2' })]
    expect(graphSeats({ reviewers: 2, schema: SCHEMA, papers })).toEqual(['1', '2', CONSOLIDATION])
  })
})

describe('graph source', () => {
  const seatTrees = { '1': { Method: [{ value: 'Survey' }] }, '2': { Method: [{ value: 'Experiment' }] } }

  // [utest->req~dat-490~1]
  it('reads the consolidated tree for the consolidation and the seat tree for a seat', () => {
    const papers = [makePaper({ annotations: { Method: [{ value: 'Merged' }] }, reviews: seatTrees })]
    const p = { reviewers: 2, schema: SCHEMA, papers }
    expect(defaultGraphSeat(p)).toBe(CONSOLIDATION)
    expect(graphTrees(p, CONSOLIDATION).p1).toEqual({ Method: [{ value: 'Merged' }] })
    expect(graphTrees(p, '2').p1).toEqual({ Method: [{ value: 'Experiment' }] })
  })

  // [utest->req~dat-490~1]
  it('offers only the seats and defaults to seat 1 when no consolidated answer exists', () => {
    const p = { reviewers: 2, schema: SCHEMA, papers: [makePaper({ annotations: { Relevant: [{ value: false }] }, reviews: seatTrees })] }
    expect(graphSeats(p)).toEqual(['1', '2'])
    expect(defaultGraphSeat(p)).toBe('1')
    expect(graphTrees(p, '3').p1).toEqual({})
  })

  // [utest->req~dat-490~1]
  it('uses the single tree with one reviewer and ignores seat metadata overrides', () => {
    const paper = makePaper({ title: 'Original', extra: { metadataOverrides: { title: 'Changed' } } })
    const p = { reviewers: 1, schema: SCHEMA, papers: [paper] }
    expect(graphSeats(p)).toEqual([])
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

describe('graph formats — exact text', () => {
  const tiny = buildGraph(
    {
      schema: resolveSchema([
        { name: 'Method', type: 'string', options: ['Survey'] },
        { name: 'Note', type: 'string' },
      ]),
      papers: [
        makePaper({ id: 'a(1)', title: 'T', authors: ['Ann'], year: 99, abstract: 'Abs', doi: '10.1/x' }),
        makePaper({ id: 'b', title: 'U', year: 2001 }),
      ],
    },
    { 'a(1)': { Method: [{ value: 'Survey' }], Note: [{ value: 'n1' }, { value: 'n2' }] } },
  )

  // [utest->req~dat-500~1]
  it('writes Turtle', () => {
    expect(toTurtle(tiny)).toMatchInlineSnapshot(`
      "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      @prefix schema: <https://schema.org/> .
      @prefix dcterms: <http://purl.org/dc/terms/> .
      @prefix sailor: <https://github.com/Gram21/SaiLoR/ns#> .

      <https://github.com/Gram21/SaiLoR/ns#field/Method> a rdf:Property ;
          rdfs:subPropertyOf sailor:hasAnswer ;
          rdfs:label "Method" .

      <https://github.com/Gram21/SaiLoR/ns#field/Note> a rdf:Property ;
          rdfs:subPropertyOf sailor:hasAnswer ;
          rdfs:label "Note" .

      <urn:sailor:author:ann> a schema:Person ;
          schema:name "Ann" .

      <urn:sailor:choice:Method%3DSurvey> a sailor:Choice ;
          rdfs:label "Survey" ;
          sailor:field "Method" .

      <urn:sailor:paper:a%281%29> a schema:ScholarlyArticle ;
          dcterms:title "T" ;
          dcterms:issued "99" ;
          dcterms:identifier "10.1/x" ;
          dcterms:abstract "Abs" ;
          <https://github.com/Gram21/SaiLoR/ns#field/Note> "n1" ;
          <https://github.com/Gram21/SaiLoR/ns#field/Note> "n2" ;
          dcterms:creator <urn:sailor:author:ann> ;
          <https://github.com/Gram21/SaiLoR/ns#field/Method> <urn:sailor:choice:Method%3DSurvey> .

      <urn:sailor:paper:b> a schema:ScholarlyArticle ;
          dcterms:title "U" ;
          dcterms:issued "2001"^^xsd:gYear .
      "
    `)
  })

  // [utest->req~dat-500~1]
  it('writes Turtle for venues, keywords, citations, entries, sorted values and a year that is not four digits', () => {
    const g = buildGraph(
      {
        schema: resolveSchema([
          { name: 'B', type: 'string' },
          { name: 'A', type: 'string' },
          { name: 'G', children: [{ name: 'X', type: 'string' }] },
        ]),
        papers: [makePaper({ id: 'a', title: 'T', venue: 'V', year: 20201, extra: { keywords: 'k', cites: ['b'] } }), makePaper({ id: 'b', title: 'U' })],
      },
      { a: { B: [{ value: 'b' }], A: [{ value: 'a' }], G: [{ children: { X: [{ value: 'x' }] } }] } },
    )
    expect(toTurtle(g).split('\n\n').slice(1).join('\n\n')).toMatchInlineSnapshot(`
      "<https://github.com/Gram21/SaiLoR/ns#field/A> a rdf:Property ;
          rdfs:subPropertyOf sailor:hasAnswer ;
          rdfs:label "A" .

      <https://github.com/Gram21/SaiLoR/ns#field/B> a rdf:Property ;
          rdfs:subPropertyOf sailor:hasAnswer ;
          rdfs:label "B" .

      <https://github.com/Gram21/SaiLoR/ns#field/G> a rdf:Property ;
          rdfs:subPropertyOf sailor:hasAnswer ;
          rdfs:label "G" .

      <https://github.com/Gram21/SaiLoR/ns#field/G%2FX> a rdf:Property ;
          rdfs:subPropertyOf sailor:hasAnswer ;
          rdfs:label "G/X" .

      <urn:sailor:answer:a%2FG%230> a sailor:Answer ;
          rdfs:label "G 1" ;
          sailor:field "G" ;
          <https://github.com/Gram21/SaiLoR/ns#field/G%2FX> "x" .

      <urn:sailor:keyword:k> a sailor:Keyword ;
          rdfs:label "k" .

      <urn:sailor:paper:a> a schema:ScholarlyArticle ;
          dcterms:title "T" ;
          dcterms:issued "20201" ;
          <https://github.com/Gram21/SaiLoR/ns#field/A> "a" ;
          <https://github.com/Gram21/SaiLoR/ns#field/B> "b" ;
          dcterms:references <urn:sailor:paper:b> ;
          <https://github.com/Gram21/SaiLoR/ns#field/G> <urn:sailor:answer:a%2FG%230> ;
          dcterms:subject <urn:sailor:keyword:k> ;
          dcterms:isPartOf <urn:sailor:venue:v> .

      <urn:sailor:paper:b> a schema:ScholarlyArticle ;
          dcterms:title "U" .

      <urn:sailor:venue:v> a sailor:Venue ;
          rdfs:label "V" .
      "
    `)
  })

  // [utest->req~dat-500~1]
  it('writes JSON-LD', () => {
    expect(toJsonLd(tiny)).toMatchInlineSnapshot(`
      "{
        "@context": {
          "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
          "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
          "xsd": "http://www.w3.org/2001/XMLSchema#",
          "schema": "https://schema.org/",
          "dcterms": "http://purl.org/dc/terms/",
          "sailor": "https://github.com/Gram21/SaiLoR/ns#"
        },
        "@graph": [
          {
            "@id": "https://github.com/Gram21/SaiLoR/ns#field/Method",
            "@type": [
              "rdf:Property"
            ],
            "rdfs:subPropertyOf": [
              {
                "@id": "sailor:hasAnswer"
              }
            ],
            "rdfs:label": [
              "Method"
            ]
          },
          {
            "@id": "https://github.com/Gram21/SaiLoR/ns#field/Note",
            "@type": [
              "rdf:Property"
            ],
            "rdfs:subPropertyOf": [
              {
                "@id": "sailor:hasAnswer"
              }
            ],
            "rdfs:label": [
              "Note"
            ]
          },
          {
            "@id": "urn:sailor:author:ann",
            "@type": [
              "schema:Person"
            ],
            "schema:name": [
              "Ann"
            ]
          },
          {
            "@id": "urn:sailor:choice:Method%3DSurvey",
            "@type": [
              "sailor:Choice"
            ],
            "rdfs:label": [
              "Survey"
            ],
            "sailor:field": [
              "Method"
            ]
          },
          {
            "@id": "urn:sailor:paper:a%281%29",
            "@type": [
              "schema:ScholarlyArticle"
            ],
            "dcterms:title": [
              "T"
            ],
            "dcterms:issued": [
              "99"
            ],
            "dcterms:identifier": [
              "10.1/x"
            ],
            "dcterms:abstract": [
              "Abs"
            ],
            "https://github.com/Gram21/SaiLoR/ns#field/Note": [
              "n1",
              "n2"
            ],
            "dcterms:creator": [
              {
                "@id": "urn:sailor:author:ann"
              }
            ],
            "https://github.com/Gram21/SaiLoR/ns#field/Method": [
              {
                "@id": "urn:sailor:choice:Method%3DSurvey"
              }
            ]
          },
          {
            "@id": "urn:sailor:paper:b",
            "@type": [
              "schema:ScholarlyArticle"
            ],
            "dcterms:title": [
              "U"
            ],
            "dcterms:issued": [
              {
                "@value": "2001",
                "@type": "xsd:gYear"
              }
            ]
          }
        ]
      }
      "
    `)
  })

  // [utest->req~dat-500~1]
  it('writes GraphML', () => {
    expect(toGraphMl(tiny)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <graphml xmlns="http://graphml.graphdrawing.org/xmlns">
        <key id="type" for="node" attr.name="type" attr.type="string"/>
        <key id="label" for="node" attr.name="label" attr.type="string"/>
        <key id="field" for="node" attr.name="field" attr.type="string"/>
        <key id="doi" for="node" attr.name="doi" attr.type="string"/>
        <key id="year" for="node" attr.name="year" attr.type="string"/>
        <key id="abstract" for="node" attr.name="abstract" attr.type="string"/>
        <key id="v0" for="node" attr.name="Note" attr.type="string"/>
        <key id="etype" for="edge" attr.name="type" attr.type="string"/>
        <key id="efield" for="edge" attr.name="field" attr.type="string"/>
        <graph id="G" edgedefault="directed">
          <node id="author:ann">
            <data key="type">Author</data>
            <data key="label">Ann</data>
          </node>
          <node id="choice:Method=Survey">
            <data key="type">Choice</data>
            <data key="label">Survey</data>
            <data key="field">Method</data>
          </node>
          <node id="paper:a(1)">
            <data key="type">Paper</data>
            <data key="label">T</data>
            <data key="doi">10.1/x</data>
            <data key="year">99</data>
            <data key="abstract">Abs</data>
            <data key="v0">n1; n2</data>
          </node>
          <node id="paper:b">
            <data key="type">Paper</data>
            <data key="label">U</data>
            <data key="year">2001</data>
          </node>
          <edge source="paper:a(1)" target="author:ann">
            <data key="etype">authoredBy</data>
          </edge>
          <edge source="paper:a(1)" target="choice:Method=Survey">
            <data key="etype">hasAnswer</data>
            <data key="efield">Method</data>
          </edge>
        </graph>
      </graphml>
      "
    `)
  })

  // [utest->req~dat-500~1]
  it('writes CSV', () => {
    expect(toCsvNodes(tiny)).toMatchInlineSnapshot(`
      ""id","type","label","field","doi","year","abstract","Note"
      "author:ann","Author","Ann","","","","",""
      "choice:Method=Survey","Choice","Survey","Method","","","",""
      "paper:a(1)","Paper","T","","10.1/x","99","Abs","n1; n2"
      "paper:b","Paper","U","","","2001","",""
      "
    `)
    expect(toCsvEdges(tiny)).toMatchInlineSnapshot(`
      ""source","target","type","field"
      "paper:a(1)","author:ann","authoredBy",""
      "paper:a(1)","choice:Method=Survey","hasAnswer","Method"
      "
    `)
  })

  // [utest->req~dat-500~1]
  it('writes only the prefixes for an empty graph', () => {
    expect(toTurtle({ nodes: [], edges: [] })).toMatchInlineSnapshot(`
      "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      @prefix schema: <https://schema.org/> .
      @prefix dcterms: <http://purl.org/dc/terms/> .
      @prefix sailor: <https://github.com/Gram21/SaiLoR/ns#> .
      "
    `)
    expect(toJsonLd({ nodes: [], edges: [] })).toContain('"@graph": []')
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
    expect(xmlText('\u001f \uD7FF\uE000\uFFFD\uFFFF\u0000')).toBe(' \uD7FF\uE000\uFFFD')
  })

  // [utest->req~dat-510~1]
  it('escapes DEL and the other control characters as \\u escapes', () => {
    expect(turtleString('\u007f\u001f\u0000 ~')).toBe('"\\u007F\\u001F\\u0000 ~"')
  })

  // [utest->req~dat-510~1]
  it('percent-encodes every reserved character in node and field IRIs', () => {
    const g = buildGraph({ schema: [], papers: [makePaper({ id: "!'()*" })] }, {})
    expect(toTurtle(g)).toContain('<urn:sailor:paper:%21%27%28%29%2A>')
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
