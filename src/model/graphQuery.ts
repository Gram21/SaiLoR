import type { Graph, GraphEdge, GraphNode, GraphNodeType } from './graph'

export interface QueryTerm {
  negate: boolean
  type?: string
  field?: string
  value?: string
  text?: string
}

export interface GraphQuery {
  terms: QueryTerm[]
  depth: number
}

export const MAX_DEPTH = 3

const TYPES: GraphNodeType[] = ['Paper', 'Author', 'Venue', 'Keyword', 'Choice', 'Answer']
const TYPE_KEYS = new Set(TYPES.map((t) => t.toLowerCase()))

const TOKEN = /(-?)(?:([^\s:="]+)[:=])?(?:"([^"]*)"?|(\S+))/g

// [impl->req~ui-200~1]
export function parseQuery(input: string): GraphQuery {
  const terms: QueryTerm[] = []
  let depth = 1
  for (const m of input.matchAll(TOKEN)) {
    const negate = m[1] === '-'
    const key = m[2]?.toLowerCase()
    const value = (m[3] ?? m[4] ?? '').trim().toLowerCase()
    if (key === undefined) {
      if (value) terms.push({ negate, text: value })
    } else if (key === 'depth' && /^\d+$/.test(value)) {
      depth = Math.min(Number(value), MAX_DEPTH)
    } else if (key === 'type') {
      terms.push({ negate, type: value })
    } else if (key === 'field') {
      terms.push({ negate, field: value })
    } else if (TYPE_KEYS.has(key)) {
      terms.push({ negate, type: key, ...(value ? { text: value } : {}) })
    } else {
      terms.push({ negate, field: key, value })
    }
  }
  return { terms, depth }
}

interface Fact {
  field: string | null
  value: string
}

export interface GraphIndex {
  graph: Graph
  byId: Map<string, GraphNode>
  adjacent: Map<string, GraphEdge[]>
  facts: Map<string, Fact[]>
}

// [impl->req~ui-200~1]
export function indexGraph(graph: Graph): GraphIndex {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const adjacent = new Map<string, GraphEdge[]>(graph.nodes.map((n) => [n.id, []]))
  for (const e of graph.edges) {
    adjacent.get(e.source)?.push(e)
    if (e.target !== e.source) adjacent.get(e.target)?.push(e)
  }
  const own = (n: GraphNode): Fact[] => {
    const out: Fact[] = [{ field: n.type === 'Choice' ? (n.field ?? null) : null, value: n.label }]
    for (const s of [n.doi, n.abstract, n.year === undefined ? undefined : String(n.year)]) {
      if (s) out.push({ field: null, value: s })
    }
    for (const [field, values] of Object.entries(n.values)) for (const v of values) out.push({ field, value: v })
    return out
  }
  const facts = new Map<string, Fact[]>()
  const collect = (id: string): Fact[] => {
    const known = facts.get(id)
    if (known) return known
    const n = byId.get(id)!
    const out = own(n)
    facts.set(id, out)
    for (const e of adjacent.get(id) ?? []) {
      if (e.type === 'hasAnswer' && e.source === id && e.target !== id) out.push(...collect(e.target))
    }
    return out
  }
  for (const n of graph.nodes) collect(n.id)
  for (const [id, list] of facts) {
    facts.set(
      id,
      list.map((f) => ({ field: f.field?.toLowerCase() ?? null, value: f.value.toLowerCase() })),
    )
  }
  return { graph, byId, adjacent, facts }
}

const fieldMatches = (field: string | null, key: string) => field !== null && (field === key || field.endsWith(`/${key}`))

function termMatches(index: GraphIndex, node: GraphNode, term: QueryTerm): boolean {
  const facts = index.facts.get(node.id) ?? []
  const hit =
    (term.type === undefined || node.type.toLowerCase() === term.type) &&
    (term.field === undefined ||
      facts.some((f) => fieldMatches(f.field, term.field!) && (term.value === undefined || f.value === term.value))) &&
    (term.text === undefined || facts.some((f) => f.value.includes(term.text!)))
  return hit !== term.negate
}

export function neighbours(index: GraphIndex, id: string): string[] {
  return [...new Set((index.adjacent.get(id) ?? []).map((e) => (e.source === id ? e.target : e.source)))]
}

export interface SubGraph extends Graph {
  seeds: Set<string>
  total: number
}

// [impl->req~ui-210~1]
export function selectSubgraph(index: GraphIndex, query: GraphQuery, limit: number, extra: Iterable<string> = []): SubGraph {
  const degree = (id: string) => index.adjacent.get(id)?.length ?? 0
  const seeds = index.graph.nodes
    .filter((n) => query.terms.every((t) => termMatches(index, n, t)))
    .map((n) => n.id)
    .sort((a, b) => degree(b) - degree(a))
  const order = [...seeds]
  const seen = new Set(order)
  let frontier = seeds
  for (let d = 0; d < query.depth; d++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const n of neighbours(index, id)) {
        if (!seen.has(n)) {
          seen.add(n)
          next.push(n)
        }
      }
    }
    order.push(...next)
    frontier = next
  }
  const keep = new Set(order.slice(0, limit))
  for (const id of extra) if (index.byId.has(id)) keep.add(id)
  return {
    nodes: index.graph.nodes.filter((n) => keep.has(n.id)),
    edges: index.graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    seeds: new Set(seeds.filter((id) => keep.has(id))),
    total: order.length,
  }
}
