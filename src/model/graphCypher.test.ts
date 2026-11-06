// [utest->req~ui-230~1]
// [utest->req~ui-240~1]
import { describe, it, expect } from 'vitest'
import type { Graph, GraphEdge, GraphEdgeType, GraphNode } from './graph'
import { indexGraph } from './graphQuery'
import {
  CypherError,
  MAX_INPUT,
  MAX_ROWS,
  cypherSubgraph,
  formatValue,
  isCypher,
  parseCypher,
  runCypher,
} from './graphCypher'

const node = (id: string, type: GraphNode['type'], label: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  type,
  label,
  values: {},
  ...extra,
})

const GRAPH: Graph = {
  nodes: [
    node('answer:p1/Tool#0', 'Answer', 'Tool 1', { field: 'Tool', values: { 'Tool/Name': ['Ant'], Tags: ['a', 'b'] } }),
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

const run = (q: string, index = INDEX) => runCypher(index, parseCypher(q))
/** Result rows as sorted display strings. */
const rows = (q: string) =>
  run(q)
    .rows.map((r) => r.map(formatValue).join(' | '))
    .sort()
const error = (q: string) => {
  try {
    parseCypher(q)
  } catch (e) {
    if (e instanceof CypherError) return { key: e.key, params: e.params }
    throw e
  }
  throw new Error(`no error for ${q}`)
}

describe('isCypher', () => {
  it('detects queries that start with MATCH in any case', () => {
    expect(isCypher('MATCH (n) RETURN n')).toBe(true)
    expect(isCypher('  match(n) return n')).toBe(true)
    expect(isCypher('matches')).toBe(false)
    expect(isCypher('graph mining')).toBe(false)
    expect(isCypher('CREATE (n)')).toBe(false)
  })
})

describe('runCypher patterns', () => {
  it('matches labels, relationship types and direction', () => {
    const r = run('MATCH (p:Paper)-[:authoredBy]->(a:Author) RETURN p.label, a.label AS author')
    expect(r.columns).toEqual(['p.label', 'author'])
    expect(rows('MATCH (p:Paper)-[:authoredBy]->(a:Author) RETURN p.label, a.label')).toEqual([
      'Graph Mining | Ada Lovelace',
      'Testing Things | Ada Lovelace',
      'Testing Things | Alan Turing',
    ])
    expect(rows('MATCH (a:Author)-[:authoredBy]->(p) RETURN p')).toEqual([])
    expect(rows('MATCH (a:Author)<-[:authoredBy]-(p) RETURN a.label, count(*) AS n')).toEqual([
      'Ada Lovelace | 2',
      'Alan Turing | 1',
    ])
    expect(rows('MATCH (a:Author)-[:authoredBy]-(p) RETURN count(*)')).toEqual(['3'])
    expect(rows('MATCH (a:Author)<-->(p) RETURN count(*)')).toEqual(['3'])
    expect(rows('MATCH (p)-[:cites|publishedIn]->(x) RETURN x.label')).toEqual(['Graph Mining', 'ICSE'])
  })

  it('reads labels and types in any case and with underscores', () => {
    expect(rows('match (p:paper)-[:AUTHORED_BY]->(a:AUTHOR) return count(*)')).toEqual(['3'])
  })

  it('follows variable-length relationships', () => {
    expect(rows("MATCH (p:Paper {label: 'Testing Things'})-[*2]->(x) RETURN x.label")).toEqual([
      'Ada Lovelace',
      'ICSE',
      'Survey',
      'Tool 1',
    ])
    expect(rows("MATCH (p {id: 'paper:p1'})-[:hasAnswer*1..2]->(c:Choice) RETURN c.label")).toEqual(['Survey', 'true'])
    expect(rows('MATCH (a:Answer)-[*0..1]->(x) RETURN x.label')).toEqual(['Tool 1', 'true'])
    expect(rows('MATCH (a:Answer)-[*..2]->(x) RETURN x.label')).toEqual(['true'])
    expect(rows("MATCH (p {id: 'paper:p2'})-[r*]->(x:Choice) RETURN r")).toEqual([
      '[cites, hasAnswer (Method)]',
      '[cites, hasAnswer (Tool), hasAnswer (Tool/Open)]',
      '[hasAnswer (Method)]',
    ])
  })

  it('uses each relationship at most once per match', () => {
    expect(rows('MATCH (a:Author)<-[:authoredBy]-(p)-[:authoredBy]->(b:Author) RETURN a.label, b.label')).toEqual([
      'Ada Lovelace | Alan Turing',
      'Alan Turing | Ada Lovelace',
    ])
    const two = rows("MATCH (a {id: 'author:ada'})-[*2]-(b) RETURN b.label")
    expect(two).toEqual(['Alan Turing', 'Experiment', 'Graph Mining', 'ICSE', 'Survey', 'Testing Things', 'Tool 1'])
  })

  it('joins several patterns and MATCH clauses on shared variables', () => {
    expect(rows('MATCH (p:Paper)-[:cites]->(q) MATCH (q)-[:publishedIn]->(v) RETURN p.label, v.label')).toEqual([
      'Testing Things | ICSE',
    ])
    expect(rows('MATCH (p:Paper)-[:authoredBy]->(a), (p)-[:cites]->(q) RETURN a.label, q.label')).toEqual([
      'Ada Lovelace | Graph Mining',
      'Alan Turing | Graph Mining',
    ])
    expect(rows('MATCH (v:Venue), (a:Author) RETURN count(*)')).toEqual(['2'])
  })
})

describe('runCypher WHERE', () => {
  it('compares values and strings', () => {
    expect(rows('MATCH (p:Paper) WHERE p.year >= 2020 RETURN p.label')).toEqual(['Graph Mining'])
    expect(rows('MATCH (p:Paper) WHERE p.year > 2019.5 AND p.year <= 2020 RETURN p.label')).toEqual(['Graph Mining'])
    expect(rows('MATCH (p:Paper) WHERE p.year < 2020 RETURN p.label')).toEqual([])
    expect(rows("MATCH (p:Paper) WHERE p.label <> 'Graph Mining' RETURN p.label")).toEqual(['Testing Things'])
    expect(rows("MATCH (p:Paper) WHERE p.label STARTS WITH 'Graph' RETURN p.label")).toEqual(['Graph Mining'])
    expect(rows("MATCH (p:Paper) WHERE p.label ENDS WITH 'Things' RETURN p.label")).toEqual(['Testing Things'])
    expect(rows("MATCH (p:Paper) WHERE p.label CONTAINS 'ing' RETURN p.label")).toEqual(['Graph Mining', 'Testing Things'])
    expect(rows("MATCH (p:Paper) WHERE p.label IN ['Testing Things', 'x'] RETURN p.label")).toEqual(['Testing Things'])
    expect(rows("MATCH (p:Paper) WHERE p.label < 'H' RETURN p.label")).toEqual(['Graph Mining'])
    expect(rows("MATCH (p:Paper) WHERE p.label > 1 OR p.year CONTAINS '2' RETURN p")).toEqual([])
    expect(rows("MATCH (p:Paper) WHERE p.label = \"Graph Mining\" AND p = p RETURN p.doi")).toEqual(['10.1/one'])
    expect(rows('MATCH (p:Paper) WHERE p.year = -1 RETURN p')).toEqual([])
  })

  it('uses three-valued logic for null', () => {
    expect(rows('MATCH (p:Paper) WHERE p.year IS NULL RETURN p.label')).toEqual(['Testing Things'])
    expect(rows('MATCH (p:Paper) WHERE p.year IS NOT NULL RETURN p.label')).toEqual(['Graph Mining'])
    expect(rows('MATCH (p:Paper) WHERE NOT p.year = 2020 RETURN p.label')).toEqual([])
    expect(rows('MATCH (p:Paper) WHERE p.year = 2020 OR p.doi IS NULL RETURN p.label')).toEqual(['Graph Mining', 'Testing Things'])
    expect(rows('MATCH (p:Paper) WHERE p.year = 2020 OR p.year = 1 RETURN p.label')).toEqual(['Graph Mining'])
    expect(rows('MATCH (p:Paper) WHERE NOT (p.year = 1 AND p.doi IS NULL) RETURN p.label')).toEqual(['Graph Mining'])
    expect(rows('MATCH (p:Paper) WHERE p.year IN [1, null] RETURN p')).toEqual([])
    expect(rows('MATCH (p:Paper) WHERE NOT p.year IN [1, null] RETURN p')).toEqual([])
    expect(rows('MATCH (p:Paper) WHERE p.year IN 2020 RETURN p')).toEqual([])
    expect(rows('MATCH (p:Paper) WHERE null RETURN p')).toEqual([])
    expect(rows('MATCH (p:Paper) WHERE true AND NOT false RETURN count(*)')).toEqual(['2'])
    expect(rows('MATCH (p:Paper) WHERE [p.year, 1] = [2020, 1] RETURN p.label')).toEqual(['Graph Mining'])
    expect(rows('MATCH (p:Paper) WHERE [p.year] = [1, 2] OR [p.year, 1] = [null, 2] RETURN p.label')).toEqual([])
  })

  it('reads schema values and relationship properties', () => {
    expect(rows("MATCH (p) WHERE p.Note = 'see appendix' RETURN p.label")).toEqual(['Graph Mining'])
    expect(rows('MATCH (a:Answer) RETURN a.`Tool/Name`, a.Tags, a.field, a.type, a.abstract')).toEqual([
      'Ant | [a, b] | Tool | Answer | null',
    ])
    expect(rows("MATCH (p)-[r:hasAnswer {field: 'Method'}]->(c) RETURN c.label, r, r.type, r.field")).toEqual([
      'Experiment | hasAnswer (Method) | hasAnswer | Method',
      'Survey | hasAnswer (Method) | hasAnswer | Method',
    ])
    expect(rows('MATCH (p)-[r:cites]->(q) RETURN r, r.field, r.label')).toEqual(['cites | null | null'])
    expect(rows('MATCH (p)-[r*1]->(q:Venue) RETURN r.type')).toEqual(['null'])
  })
})

describe('runCypher RETURN', () => {
  it('removes duplicates with DISTINCT', () => {
    expect(rows('MATCH (p:Paper)-[:authoredBy]->(a) RETURN a.label')).toHaveLength(3)
    expect(rows('MATCH (p:Paper)-[:authoredBy]->(a) RETURN DISTINCT a.label')).toEqual(['Ada Lovelace', 'Alan Turing'])
    expect(rows('MATCH (p:Paper)-[:authoredBy]->(a) RETURN DISTINCT a')).toEqual(['Ada Lovelace', 'Alan Turing'])
  })

  it('counts rows and groups by the other columns', () => {
    expect(rows('MATCH (n) RETURN count(*)')).toEqual(['9'])
    expect(rows('MATCH (n) RETURN n.type, count(*) AS c')).toEqual([
      'Answer | 1',
      'Author | 2',
      'Choice | 3',
      'Paper | 2',
      'Venue | 1',
    ])
    expect(rows("MATCH (n:Venue {label: 'x'}) RETURN count(*), count(*)")).toEqual(['0 | 0'])
    expect(rows("MATCH (n:Venue {label: 'x'}) RETURN n.label, count(*)")).toEqual([])
    expect(run('MATCH (n) RETURN n.type, count(*) LIMIT 2').rows).toHaveLength(2)
  })

  it('applies LIMIT', () => {
    const r = run('MATCH (n) RETURN n LIMIT 2')
    expect(r.rows).toHaveLength(2)
    expect(r.truncated).toBe(false)
    expect(run('MATCH (n) RETURN n LIMIT 0').rows).toEqual([])
    expect(run('MATCH (n) RETURN n LIMIT 100').rows).toHaveLength(9)
  })

  it('returns literals, lists and whole values', () => {
    expect(rows("MATCH (v:Venue) RETURN 1, 'x', true, null, [v.label, 2], v")).toEqual(['1 | x | true | null | [ICSE, 2] | ICSE'])
    expect(rows("MATCH (v:Venue) RETURN 'it\\'s\\n'")).toEqual(["it's\n"])
  })
})

describe('formatValue', () => {
  it('shows nodes, relationships, lists and scalars', () => {
    const edge: GraphEdge = { source: 'a', target: 'b', type: 'cites' }
    expect(formatValue(null)).toBe('null')
    expect(formatValue(false)).toBe('false')
    expect(formatValue(2.5)).toBe('2.5')
    expect(formatValue(GRAPH.nodes[1])).toBe('Ada Lovelace')
    expect(formatValue(edge)).toBe('cites')
    expect(formatValue([edge, [1, 'x']])).toBe('[cites, [1, x]]')
  })
})

describe('cypherSubgraph', () => {
  it('shows the matched paths, seeds the returned nodes and adds revealed nodes', () => {
    const r = run('MATCH (p:Paper)-[:authoredBy]->(a:Author) RETURN p')
    expect([...r.nodes].sort()).toEqual(['author:ada', 'author:alan', 'paper:p1', 'paper:p2'])
    expect([...r.seeds].sort()).toEqual(['paper:p1', 'paper:p2'])
    const sub = cypherSubgraph(INDEX, r, ['venue:icse', 'missing'])
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(['author:ada', 'author:alan', 'paper:p1', 'paper:p2', 'venue:icse'])
    expect(sub.edges.map((e) => `${e.source}>${e.target}`).sort()).toEqual([
      'paper:p1>author:ada',
      'paper:p1>venue:icse',
      'paper:p2>author:ada',
      'paper:p2>author:alan',
    ])
    expect(sub.seeds).toBe(r.seeds)
    expect(cypherSubgraph(INDEX, run("MATCH (p {id: 'paper:p2'})-[r*2]->(x:Venue) RETURN x")).edges).toHaveLength(2)
  })
})

describe('parseCypher errors', () => {
  it('names the unexpected token, its position and an early end', () => {
    expect(error('MATCH (n) RETURN n; MATCH (m) RETURN m')).toEqual({
      key: 'graphView.cypher.unexpected',
      params: { token: ';', at: 19 },
    })
    expect(error('MATCH (n) WHERE n.label =~ ".*" RETURN n')).toEqual({
      key: 'graphView.cypher.unexpected',
      params: { token: '~', at: 26 },
    })
    expect(error('MATCH (n')).toEqual({ key: 'graphView.cypher.end', params: {} })
    expect(error('MATCH (n) RETURN')).toEqual({ key: 'graphView.cypher.end', params: {} })
    expect(error("MATCH (n) WHERE n.label STARTS 'x' RETURN n").key).toBe('graphView.cypher.unexpected')
    expect(error('MATCH (n) WHERE n.label IS 1 RETURN n').key).toBe('graphView.cypher.unexpected')
    expect(error('MATCH (n) RETURN n LIMIT -1').key).toBe('graphView.cypher.unexpected')
    expect(error('MATCH (n) RETURN n LIMIT 1.5').key).toBe('graphView.cypher.unexpected')
    expect(error('MATCH (n)-[*1..2 {field: 1}]->(m) RETURN n').key).toBe('graphView.cypher.unexpected')
    expect(error('MATCH (n) RETURN n.').key).toBe('graphView.cypher.end')
    expect(error('MATCH (n) RETURN n x').key).toBe('graphView.cypher.unexpected')
    expect(error('MATCH (n) RETURN [1, 2').key).toBe('graphView.cypher.end')
    expect(error('RETURN 1').key).toBe('graphView.cypher.unexpected')
  })

  it('rejects unterminated strings and names', () => {
    expect(error("MATCH (n) WHERE n.label = 'abc RETURN n")).toEqual({
      key: 'graphView.cypher.unterminated',
      params: { at: 27 },
    })
    expect(error('MATCH (n) WHERE n.label = "abc\\" RETURN n').key).toBe('graphView.cypher.unterminated')
    expect(error('MATCH (n) RETURN n.`abc').key).toBe('graphView.cypher.unterminated')
  })

  it('rejects write and other unsupported clauses', () => {
    for (const [q, word] of [
      ['CREATE (n)', 'CREATE'],
      ['MATCH (n) DELETE n', 'DELETE'],
      ['MATCH (n) DETACH DELETE n', 'DETACH'],
      ['MATCH (n) SET n.label = 1', 'SET'],
      ['MATCH (n) REMOVE n.label', 'REMOVE'],
      ['MATCH (n) MERGE (m)', 'MERGE'],
      ['OPTIONAL MATCH (n) RETURN n', 'OPTIONAL'],
      ['MATCH (n) WITH n RETURN n', 'WITH'],
      ['MATCH (n) RETURN n ORDER BY n.label', 'ORDER'],
      ['MATCH (n) RETURN n SKIP 1', 'SKIP'],
      ['MATCH (n) RETURN n UNION MATCH (m) RETURN m', 'UNION'],
      ['MATCH (n) CALL db.labels() RETURN n', 'CALL'],
      ['MATCH (n) unwind [1] AS x RETURN x', 'UNWIND'],
    ]) {
      expect(error(q)).toEqual({ key: 'graphView.cypher.unsupported', params: { word } })
    }
  })

  it('rejects functions, unknown names and rebound variables', () => {
    expect(error('MATCH (n) RETURN toLower(n.label)')).toEqual({ key: 'graphView.cypher.function', params: { name: 'toLower' } })
    expect(error('MATCH (n) RETURN count(n)').key).toBe('graphView.cypher.function')
    expect(error('MATCH (n) WHERE count(*) > 1 RETURN n').key).toBe('graphView.cypher.function')
    expect(error('MATCH (n) RETURN m')).toEqual({ key: 'graphView.cypher.unknownVariable', params: { name: 'm' } })
    expect(error('MATCH (n:Person) RETURN n')).toEqual({ key: 'graphView.cypher.unknownLabel', params: { name: 'Person' } })
    expect(error('MATCH (n)-[:KNOWS]->(m) RETURN n')).toEqual({ key: 'graphView.cypher.unknownType', params: { name: 'KNOWS' } })
    expect(error('MATCH (a)-[a]->(b) RETURN a')).toEqual({ key: 'graphView.cypher.rebound', params: { name: 'a' } })
    expect(error('MATCH (a)-[r]->(b)-[r]->(c) RETURN a').key).toBe('graphView.cypher.rebound')
    expect(error('MATCH (a)-[r]->(b), (r) RETURN a').key).toBe('graphView.cypher.rebound')
  })

  it('limits the hops of variable-length relationships', () => {
    for (const q of ['*1..100', '*5', '*3..1', '*..9', '*99999999999999999999']) {
      expect(error(`MATCH (a)-[${q}]->(b) RETURN b`)).toEqual({ key: 'graphView.cypher.hops', params: { max: 3 } })
    }
  })

  it('treats prototype keys as plain names', () => {
    expect(rows('MATCH (n) WHERE n.__proto__ IS NULL AND n.constructor IS NULL RETURN n.toString, n.hasOwnProperty')).toHaveLength(9)
    expect(rows('MATCH (__proto__:Paper)-->(constructor) RETURN count(*)')).toEqual(['8'])
    expect(rows('MATCH (`__proto__`:Paper {constructor: 1}) RETURN __proto__')).toEqual([])
    expect(error('MATCH (n:__proto__) RETURN n').key).toBe('graphView.cypher.unknownLabel')
    expect(error('MATCH (n:constructor) RETURN n').key).toBe('graphView.cypher.unknownLabel')
    expect(error('MATCH (n)-[:toString]->(m) RETURN n').key).toBe('graphView.cypher.unknownType')
    const own = indexGraph({ nodes: [node('x', 'Paper', 'x', { values: JSON.parse('{"__proto__": ["p"]}') })], edges: [] })
    expect(run("MATCH (n) WHERE n.__proto__ = 'p' RETURN n.label", own).rows).toEqual([['x']])
  })
})

describe('hostile input', () => {
  const quick = (f: () => void) => {
    const t0 = performance.now()
    f()
    return performance.now() - t0
  }

  it('rejects long and deeply nested queries', () => {
    expect(error(`MATCH (n) RETURN n${' '.repeat(MAX_INPUT)}`)).toEqual({ key: 'graphView.cypher.tooLong', params: { max: MAX_INPUT } })
    const deep = { key: 'graphView.cypher.tooDeep', params: { max: 32 } }
    expect(error(`MATCH (n) WHERE ${'('.repeat(500)}true${')'.repeat(500)} RETURN n`)).toEqual(deep)
    expect(error(`MATCH (n) WHERE ${'NOT '.repeat(500)}true RETURN n`)).toEqual(deep)
    expect(error(`MATCH (n) RETURN ${'['.repeat(500)}`)).toEqual(deep)
    expect(error(`MATCH (a)${'-->()'.repeat(40)} RETURN a`)).toEqual(deep)
    expect(error(`MATCH (a)${', ()'.repeat(40)} RETURN a`)).toEqual(deep)
    expect(rows(`MATCH (n:Venue) WHERE ${'(true) AND '.repeat(300)}true RETURN n`)).toEqual(['ICSE'])
    expect(rows(`MATCH (n:Venue) WHERE ${'false OR '.repeat(400)}true RETURN n`)).toEqual(['ICSE'])
  })

  it('lexes pathological strings in linear time', () => {
    for (const q of [
      `MATCH (n) WHERE n.label = '${'\\'.repeat(MAX_INPUT - 40)}`,
      `MATCH (n) WHERE n.label = '${"\\'".repeat(1900)}`,
      `MATCH (n) RETURN n.\`${'``'.repeat(1900)}`,
      `MATCH (n) RETURN ${'a'.repeat(MAX_INPUT - 20)}`,
      `MATCH (n) RETURN ${'1.'.repeat(1900)}`,
      `MATCH ${'('.repeat(1900)}`,
    ]) {
      expect(quick(() => expect(() => parseCypher(q)).toThrow(CypherError))).toBeLessThan(100)
    }
  })

  it('caps the rows of large results', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => node(`n${i}`, 'Keyword', `k${i}`))
    const index = indexGraph({ nodes, edges: [] })
    const all = run('MATCH (a), (b) RETURN a, b', index)
    expect(all.rows).toHaveLength(MAX_ROWS)
    expect(all.truncated).toBe(true)
    const limited = run('MATCH (a), (b) RETURN a, b LIMIT 20000', index)
    expect(limited.rows).toHaveLength(MAX_ROWS)
    expect(limited.truncated).toBe(true)
    expect(run('MATCH (a), (b) RETURN a, b LIMIT 10000', index).truncated).toBe(false)
    expect(run('MATCH (a) RETURN a', index).truncated).toBe(false)
    const grouped = run('MATCH (a), (b) RETURN a, b, count(*)', index)
    expect(grouped.rows).toHaveLength(MAX_ROWS)
    expect(grouped.truncated).toBe(true)
  })

  it('stops a huge cartesian product and a hub expansion at the work limit', () => {
    const nodes = Array.from({ length: 3000 }, (_, i) => node(`n${i}`, 'Keyword', `k${i}`))
    const edges = nodes.slice(1).map((n): GraphEdge => ({ source: 'n0', target: n.id, type: 'hasKeyword' }))
    const index = indexGraph({ nodes, edges })
    let r = run('MATCH (a), (b), (c) RETURN count(*)', index)
    expect(quick(() => (r = run('MATCH (a), (b), (c) RETURN count(*)', index)))).toBeLessThan(5000)
    expect(r.truncated).toBe(true)
    expect(quick(() => (r = run('MATCH (a)-[*3]-(b) RETURN DISTINCT a', index)))).toBeLessThan(5000)
    expect(r.truncated).toBe(true)
  })
})

/** Synthetic SLR-like graph: one in five nodes is a paper with twenty relationships. */
function bigGraph(n: number, perPaper: number): Graph {
  let seed = 7
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const others = ['Author', 'Venue', 'Keyword', 'Answer'] as const
  const types: GraphEdgeType[] = ['authoredBy', 'authoredBy', 'hasKeyword', 'cites', 'hasAnswer']
  const nodes = Array.from({ length: n }, (_, i) =>
    node(`n${i}`, i % 5 === 0 ? 'Paper' : others[i % 4], `Node number ${i}`, i % 5 === 0 ? { year: 1990 + (i % 35) } : {}),
  )
  const edges: GraphEdge[] = []
  for (let i = 0; i < n; i += 5) {
    for (let e = 0; e < perPaper; e++) {
      const type = types[e % 5]
      const target = type === 'cites' ? Math.floor(rand() * (n / 5)) * 5 : Math.floor(rand() * n)
      edges.push({ source: `n${i}`, target: `n${target}`, type })
    }
  }
  return { nodes, edges }
}

// Budgets are about 10× the times measured on a laptop, so slow CI runners do not fail them.
describe('performance on 150k nodes and 600k relationships', () => {
  const graph = bigGraph(150_000, 20)
  const t0 = performance.now()
  const index = indexGraph(graph)
  const indexMs = performance.now() - t0
  const timed = (q: string) => {
    const t = performance.now()
    const r = run(q, index)
    return { ms: performance.now() - t, r }
  }

  it('has the expected size', () => {
    expect(graph.nodes).toHaveLength(150_000)
    expect(graph.edges).toHaveLength(600_000)
    expect(indexMs).toBeLessThan(20_000)
  })

  it('answers typical queries within budget', { timeout: 60_000 }, () => {
    const results: Record<string, number> = { index: indexMs }
    const cases: [string, string, number][] = [
      ['filter', "MATCH (p:Paper) WHERE p.label STARTS WITH 'Node number 1' AND p.year >= 2000 RETURN count(*)", 1000],
      ['oneHop', "MATCH (p:Paper)-[:authoredBy]->(a:Author) WHERE a.label STARTS WITH 'Node number 47' RETURN p, a", 3000],
      ['twoHopCites', "MATCH (p:Paper {id: 'n0'})-[:cites*1..2]->(q:Paper) RETURN DISTINCT q", 1000],
      ['countByYear', 'MATCH (p:Paper)-[:cites]->(q:Paper) RETURN q.year, count(*)', 5000],
      ['rowCap', 'MATCH (n) RETURN n', 1000],
      ['coAuthors', 'MATCH (a:Author)<-[:authoredBy]-(p)-[:authoredBy]->(b:Author) RETURN count(*)', 3000],
      ['workCap', 'MATCH (a)-[*3]-(b) RETURN count(*)', 5000],
    ]
    for (const [name, q, budget] of cases) {
      const { ms, r } = timed(q)
      results[name] = Math.round(ms * 10) / 10
      results[`${name}Rows`] = r.truncated ? -r.rows.length : r.rows.length
      expect(ms, name).toBeLessThan(budget)
      if (name === 'rowCap') expect(r.rows).toHaveLength(MAX_ROWS)
      if (name === 'workCap') expect(r.truncated).toBe(true)
      if (name === 'oneHop' || name === 'twoHopCites') expect(r.rows.length, name).toBeGreaterThan(0)
    }
    console.info('cypher perf (ms)', JSON.stringify(results))
  })
})
