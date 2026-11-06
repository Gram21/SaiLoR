import { describe, it, expect } from 'vitest'
import type { Graph, GraphNode } from './graph'
import { indexGraph, neighbours, parseQuery, selectSubgraph } from './graphQuery'

const node = (id: string, type: GraphNode['type'], label: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  type,
  label,
  values: {},
  ...extra,
})

const GRAPH: Graph = {
  nodes: [
    node('answer:p1/Tool#0', 'Answer', 'Tool 1', { field: 'Tool', values: { 'Tool/Name': ['Ant'] } }),
    node('author:ada', 'Author', 'Ada Lovelace'),
    node('author:alan', 'Author', 'Alan Turing'),
    node('choice:Method=Survey', 'Choice', 'Survey', { field: 'Method' }),
    node('choice:Method=Experiment', 'Choice', 'Experiment', { field: 'Method' }),
    node('choice:Tool/Open=true', 'Choice', 'true', { field: 'Tool/Open' }),
    node('paper:p1', 'Paper', 'Graph Mining', { doi: '10.1/one', year: 2020, values: { Note: ['see appendix'] } }),
    node('paper:p2', 'Paper', 'Testing Things'),
    node('venue:icse', 'Venue', 'ICSE'),
  ],
  edges: [
    { source: 'paper:p1', target: 'author:ada', type: 'authoredBy' },
    { source: 'paper:p1', target: 'venue:icse', type: 'publishedIn' },
    { source: 'paper:p1', target: 'choice:Method=Survey', type: 'hasAnswer', field: 'Method' },
    { source: 'paper:p1', target: 'answer:p1/Tool#0', type: 'hasAnswer', field: 'Tool' },
    { source: 'answer:p1/Tool#0', target: 'choice:Tool/Open=true', type: 'hasAnswer', field: 'Tool/Open' },
    { source: 'paper:p2', target: 'author:ada', type: 'authoredBy' },
    { source: 'paper:p2', target: 'author:alan', type: 'authoredBy' },
    { source: 'paper:p2', target: 'choice:Method=Experiment', type: 'hasAnswer', field: 'Method' },
    { source: 'paper:p2', target: 'paper:p1', type: 'cites' },
  ],
}

const INDEX = indexGraph(GRAPH)
const ids = (q: string, limit = 100) => selectSubgraph(INDEX, parseQuery(q), limit).nodes.map((n) => n.id).sort()
const seeds = (q: string) => [...selectSubgraph(INDEX, parseQuery(q), 100).seeds].sort()

// [utest->req~ui-200~1]
describe('parseQuery', () => {
  it('reads words, phrases, keys, negation and depth', () => {
    expect(parseQuery('graph "machine Learning" -type:Paper Method=Survey author:"Ada L" field:Note depth:2')).toEqual({
      terms: [
        { negate: false, text: 'graph' },
        { negate: false, text: 'machine learning' },
        { negate: true, type: 'paper' },
        { negate: false, field: 'method', value: 'survey' },
        { negate: false, type: 'author', text: 'ada l' },
        { negate: false, field: 'note' },
      ],
      depth: 2,
    })
  })

  it('defaults to depth 1, caps the depth and treats other keys as fields', () => {
    expect(parseQuery('')).toEqual({ terms: [], depth: 1 })
    expect(parseQuery('depth:9').depth).toBe(3)
    expect(parseQuery('depth:0').depth).toBe(0)
    expect(parseQuery('Tool/Open:true').terms).toEqual([{ negate: false, field: 'tool/open', value: 'true' }])
  })

  it('keeps an unclosed quote and a lone dash as text', () => {
    expect(parseQuery('"open end').terms).toEqual([{ negate: false, text: 'open end' }])
    expect(parseQuery('-').terms).toEqual([{ negate: false, text: '-' }])
  })
})

// [utest->req~ui-200~1]
describe('query matching', () => {
  it('matches text in labels, DOIs, years and values, case-insensitively', () => {
    expect(seeds('graph')).toEqual(['paper:p1'])
    expect(seeds('10.1/ONE')).toEqual(['paper:p1'])
    expect(seeds('2020')).toEqual(['paper:p1'])
    expect(seeds('appendix')).toEqual(['paper:p1'])
  })

  it('lets a paper match the answers below it, also nested ones', () => {
    expect(seeds('Method=Survey')).toEqual(['choice:Method=Survey', 'paper:p1'])
    expect(seeds('type:paper Open=true')).toEqual(['paper:p1'])
    expect(seeds('type:paper Name=ant')).toEqual(['paper:p1'])
    expect(seeds('type:paper field:Method')).toEqual(['paper:p1', 'paper:p2'])
  })

  it('combines terms with AND and excludes negated terms', () => {
    expect(seeds('type:paper -Method=Survey')).toEqual(['paper:p2'])
    expect(seeds('author:ada')).toEqual(['author:ada'])
    expect(seeds('-author:ada type:author')).toEqual(['author:alan'])
    expect(seeds('type:nothing')).toEqual([])
  })
})

// [utest->req~ui-210~1]
describe('selectSubgraph', () => {
  it('returns the whole graph for an empty query', () => {
    const sub = selectSubgraph(INDEX, parseQuery(''), 100)
    expect(sub.nodes).toHaveLength(GRAPH.nodes.length)
    expect(sub.edges).toHaveLength(GRAPH.edges.length)
    expect(sub.total).toBe(GRAPH.nodes.length)
  })

  it('adds neighbours up to the depth in both edge directions', () => {
    expect(ids('author:alan depth:0')).toEqual(['author:alan'])
    expect(ids('author:alan')).toEqual(['author:alan', 'paper:p2'])
    expect(ids('author:alan depth:2')).toEqual(['author:ada', 'author:alan', 'choice:Method=Experiment', 'paper:p1', 'paper:p2'])
  })

  it('keeps only the edges between kept nodes', () => {
    const sub = selectSubgraph(INDEX, parseQuery('author:alan'), 100)
    expect(sub.edges).toEqual([{ source: 'paper:p2', target: 'author:alan', type: 'authoredBy' }])
  })

  it('cuts at the limit, keeps the best connected matches first and reports the total', () => {
    const sub = selectSubgraph(INDEX, parseQuery('type:paper depth:0'), 1)
    expect(sub.nodes.map((n) => n.id)).toEqual(['paper:p1'])
    expect(sub.total).toBe(2)
    expect(selectSubgraph(INDEX, parseQuery('author:alan'), 1).nodes.map((n) => n.id)).toEqual(['author:alan'])
  })

  it('adds expanded nodes beyond the limit and ignores unknown ids', () => {
    const sub = selectSubgraph(INDEX, parseQuery('author:alan depth:0'), 1, ['paper:p2', 'nope'])
    expect(sub.nodes.map((n) => n.id)).toEqual(['author:alan', 'paper:p2'])
    expect(sub.seeds).toEqual(new Set(['author:alan']))
  })
})

describe('neighbours', () => {
  it('lists each neighbour once, in both directions', () => {
    expect(neighbours(INDEX, 'author:ada').sort()).toEqual(['paper:p1', 'paper:p2'])
    expect(neighbours(INDEX, 'unknown')).toEqual([])
  })
})
