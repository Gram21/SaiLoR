// [impl->req~ui-230~1]
// [impl->req~ui-240~1]
import type { Graph, GraphEdge, GraphEdgeType, GraphNode, GraphNodeType } from './graph'
import { indexGraph, type GraphIndex, type SubGraph } from './graphQuery'
import type { MessageKey, Params } from '../i18n'

export const MAX_INPUT = 4000
export const MAX_NESTING = 32
export const MAX_HOPS = 3
export const MAX_ROWS = 10_000
export const MAX_WORK = 2_000_000

/** A query problem; key and params name the i18n message. */
export class CypherError extends Error {
  constructor(
    readonly key: MessageKey,
    readonly params: Params = {},
  ) {
    super(key)
  }
}

export type Val = null | boolean | number | string | GraphNode | GraphEdge | Val[]
type Kind = 'node' | 'rel' | 'rels'

type Expr =
  | { op: 'lit'; v: Val }
  | { op: 'list'; items: Expr[] }
  | { op: 'var'; slot: number }
  | { op: 'prop'; slot: number; name: string }
  | { op: 'count' }
  | { op: 'not'; a: Expr }
  | { op: 'and' | 'or' | 'cmp'; cmp?: string; a: Expr; b: Expr }
  | { op: 'null'; a: Expr; negate: boolean }

interface NodePat {
  slot: number
  label?: GraphNodeType
}
interface RelPat {
  slot: number
  dir: -1 | 0 | 1
  types: Set<GraphEdgeType> | null
  min: number
  max: number
  varLen: boolean
  flip?: boolean
}
interface Chain {
  /** Index of the MATCH clause; each clause uses a relationship at most once. */
  clause: number
  nodes: NodePat[]
  rels: RelPat[]
}

export interface CypherQuery {
  chains: Chain[]
  where: Expr[]
  items: { expr: Expr; name: string }[]
  distinct: boolean
  limit: number
  slots: Kind[]
}

export const isCypher = (input: string) => /^\s*match\b/i.test(input)

const norm = (s: string) => s.toLowerCase().replace(/_/g, '')
const NODE_LABELS: GraphNodeType[] = ['Paper', 'Author', 'Venue', 'Keyword', 'Choice', 'Answer']
const EDGE_TYPES: GraphEdgeType[] = ['authoredBy', 'publishedIn', 'hasKeyword', 'cites', 'hasAnswer']
const LABELS = new Map(NODE_LABELS.map((l) => [norm(l), l]))
const TYPES = new Map(EDGE_TYPES.map((l) => [norm(l), l]))
const UNSUPPORTED = new Set(
  'CREATE MERGE DELETE DETACH SET REMOVE OPTIONAL WITH UNWIND CALL ORDER SKIP UNION LOAD FOREACH'.split(' '),
)
const CMP = new Set(['=', '<>', '<', '<=', '>', '>='])

interface Tok {
  k: 'id' | 'str' | 'num' | 'p' | 'eof'
  v: string
  at: number
  end: number
  quoted?: boolean
}

// Each alternative is unambiguous, so the sticky scan is linear in the input length.
const LEX = /\s+|([\p{L}_][\p{L}\p{N}_]*)|`((?:[^`]|``)*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(\d+(?:\.\d+)?)|(<>|<=|>=|\.\.|[-<>=()[\]{}:,.|*])/suy
const unescape = (s: string) => s.replace(/\\(.)/gsu, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))

function lex(input: string): Tok[] {
  const out: Tok[] = []
  let at = 0
  while (at < input.length) {
    LEX.lastIndex = at
    const m = LEX.exec(input)
    if (!m) {
      const c = String.fromCodePoint(input.codePointAt(at)!)
      if ('\'"`'.includes(c)) throw new CypherError('graphView.cypher.unterminated', { at: at + 1 })
      throw new CypherError('graphView.cypher.unexpected', { token: c, at: at + 1 })
    }
    const end = at + m[0].length
    if (m[1] !== undefined) out.push({ k: 'id', v: m[1], at, end })
    else if (m[2] !== undefined) out.push({ k: 'id', v: m[2].replace(/``/g, '`'), at, end, quoted: true })
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ k: 'str', v: unescape(m[3] ?? m[4]), at, end })
    else if (m[5] !== undefined) out.push({ k: 'num', v: m[5], at, end })
    else if (m[6] !== undefined) out.push({ k: 'p', v: m[6], at, end })
    at = end
  }
  out.push({ k: 'eof', v: '', at, end: at })
  return out
}

/** Parses the read-only Cypher subset; throws CypherError with a readable reason. */
export function parseCypher(input: string): CypherQuery {
  if (input.length > MAX_INPUT) throw new CypherError('graphView.cypher.tooLong', { max: MAX_INPUT })
  const toks = lex(input)
  let i = 0
  let depth = 0
  let parts = 0
  const slots: Kind[] = []
  const vars = new Map<string, number>()

  const fail = (t = toks[i]): never => {
    if (t.k === 'eof') throw new CypherError('graphView.cypher.end')
    if (t.k === 'id' && !t.quoted && UNSUPPORTED.has(t.v.toUpperCase())) {
      throw new CypherError('graphView.cypher.unsupported', { word: t.v.toUpperCase() })
    }
    throw new CypherError('graphView.cypher.unexpected', { token: input.slice(t.at, t.end), at: t.at + 1 })
  }
  const isP = (v: string, ahead = 0) => toks[i + ahead]?.k === 'p' && toks[i + ahead].v === v
  const eat = (v: string) => {
    if (!isP(v)) return false
    i++
    return true
  }
  const expect = (v: string) => {
    if (!eat(v)) fail()
  }
  const word = (w: string, ahead = 0) => toks[i + ahead]?.k === 'id' && !toks[i + ahead].quoted && toks[i + ahead].v.toUpperCase() === w
  const keyword = (w: string) => {
    if (!word(w)) return false
    i++
    return true
  }
  const name = () => (toks[i].k === 'id' ? toks[i++].v : fail())
  const int = () => (toks[i].k === 'num' && /^\d+$/.test(toks[i].v) ? Number(toks[i++].v) : undefined)
  const nest = <T>(f: () => T): T => {
    if (++depth > MAX_NESTING) throw new CypherError('graphView.cypher.tooDeep', { max: MAX_NESTING })
    try {
      return f()
    } finally {
      depth--
    }
  }
  const bind = (v: string | undefined, kind: Kind) => {
    if (v === undefined) return slots.push(kind) - 1
    const s = vars.get(v)
    if (s === undefined) {
      vars.set(v, slots.length)
      return slots.push(kind) - 1
    }
    if (kind !== 'node' || slots[s] !== 'node') throw new CypherError('graphView.cypher.rebound', { name: v })
    return s
  }

  const expr = (): Expr =>
    nest(() => {
      let a = and()
      while (keyword('OR')) a = { op: 'or', a, b: and() }
      return a
    })
  const and = (): Expr => {
    let a = not()
    while (keyword('AND')) a = { op: 'and', a, b: not() }
    return a
  }
  const not = (): Expr => (keyword('NOT') ? nest(() => ({ op: 'not', a: not() })) : cmp())
  const cmp = (): Expr => {
    const a = atom()
    const t = toks[i]
    if (t.k === 'p' && CMP.has(t.v)) {
      i++
      return { op: 'cmp', cmp: t.v, a, b: atom() }
    }
    for (const [w, op] of [['CONTAINS', 'contains'], ['STARTS', 'starts'], ['ENDS', 'ends'], ['IN', 'in']]) {
      if (!keyword(w)) continue
      if (op === 'starts' || op === 'ends') {
        if (!keyword('WITH')) fail()
      }
      return { op: 'cmp', cmp: op, a, b: atom() }
    }
    if (keyword('IS')) {
      const negate = keyword('NOT')
      if (!keyword('NULL')) fail()
      return { op: 'null', a, negate }
    }
    return a
  }
  const atom = (): Expr => {
    const t = toks[i++]
    if (t.k === 'str') return { op: 'lit', v: t.v }
    if (t.k === 'num') return { op: 'lit', v: Number(t.v) }
    if (t.k === 'p' && t.v === '-' && toks[i].k === 'num') return { op: 'lit', v: -Number(toks[i++].v) }
    if (t.k === 'p' && t.v === '(') {
      const e = expr()
      expect(')')
      return e
    }
    if (t.k === 'p' && t.v === '[') {
      return nest(() => {
        const items: Expr[] = []
        if (eat(']')) return { op: 'list', items }
        do items.push(expr())
        while (eat(','))
        expect(']')
        return { op: 'list', items }
      })
    }
    if (t.k === 'id') {
      const up = t.quoted ? '' : t.v.toUpperCase()
      if (up === 'TRUE' || up === 'FALSE') return { op: 'lit', v: up === 'TRUE' }
      if (up === 'NULL') return { op: 'lit', v: null }
      if (isP('(')) throw new CypherError('graphView.cypher.function', { name: t.v })
      const slot = vars.get(t.v)
      if (slot === undefined) throw new CypherError('graphView.cypher.unknownVariable', { name: t.v })
      return eat('.') ? { op: 'prop', slot, name: name() } : { op: 'var', slot }
    }
    return fail(t)
  }

  const props = (slot: number, where: Expr[]) => {
    expect('{')
    if (eat('}')) return
    do {
      const key = name()
      expect(':')
      where.push({ op: 'cmp', cmp: '=', a: { op: 'prop', slot, name: key }, b: expr() })
    } while (eat(','))
    expect('}')
  }
  const nodePat = (where: Expr[]): NodePat => {
    expect('(')
    const v = toks[i].k === 'id' ? name() : undefined
    let label: GraphNodeType | undefined
    if (eat(':')) {
      const l = name()
      label = LABELS.get(norm(l))
      if (!label) throw new CypherError('graphView.cypher.unknownLabel', { name: l })
    }
    const slot = bind(v, 'node')
    if (isP('{')) props(slot, where)
    expect(')')
    return { slot, label }
  }
  const relPat = (where: Expr[]): RelPat | null => {
    const left = isP('<') && isP('-', 1)
    if (left) i += 2
    else if (!eat('-')) return null
    if (++parts > MAX_NESTING) throw new CypherError('graphView.cypher.tooDeep', { max: MAX_NESTING })
    let v: string | undefined
    let types: Set<GraphEdgeType> | null = null
    let [min, max, varLen] = [1, 1, false]
    let slot = -1
    if (eat('[')) {
      if (toks[i].k === 'id') v = name()
      if (eat(':')) {
        do {
          eat(':')
          const n = name()
          const type = TYPES.get(norm(n))
          if (!type) throw new CypherError('graphView.cypher.unknownType', { name: n })
          ;(types ??= new Set()).add(type)
        } while (eat('|'))
      }
      if (eat('*')) {
        varLen = true
        const lo = int()
        if (eat('..')) [min, max] = [lo ?? 1, int() ?? MAX_HOPS]
        else [min, max] = lo === undefined ? [1, MAX_HOPS] : [lo, lo]
        if (max > MAX_HOPS || min > max) throw new CypherError('graphView.cypher.hops', { max: MAX_HOPS })
      }
      slot = bind(v, varLen ? 'rels' : 'rel')
      if (isP('{')) {
        if (varLen) fail()
        props(slot, where)
      }
      expect(']')
    } else slot = bind(undefined, 'rel')
    expect('-')
    const right = eat('>')
    return { slot, dir: left === right ? 0 : right ? 1 : -1, types, min, max, varLen }
  }
  let clause = 0
  const chain = (where: Expr[]): Chain => {
    if (++parts > MAX_NESTING) throw new CypherError('graphView.cypher.tooDeep', { max: MAX_NESTING })
    const nodes = [nodePat(where)]
    const rels: RelPat[] = []
    for (let r = relPat(where); r; r = relPat(where)) {
      rels.push(r)
      nodes.push(nodePat(where))
    }
    return { clause, nodes, rels }
  }

  if (!keyword('MATCH')) fail()
  const chains: Chain[] = []
  const where: Expr[] = []
  do {
    do chains.push(chain(where))
    while (eat(','))
    if (keyword('WHERE')) where.push(expr())
    clause++
  } while (keyword('MATCH'))
  if (!keyword('RETURN')) fail()
  const distinct = keyword('DISTINCT')
  const items: CypherQuery['items'] = []
  do {
    const start = toks[i].at
    let e: Expr
    if (word('COUNT') && isP('(', 1) && isP('*', 2) && isP(')', 3)) {
      i += 4
      e = { op: 'count' }
    } else e = expr()
    let label = input.slice(start, toks[i - 1].end)
    if (keyword('AS')) label = name()
    items.push({ expr: e, name: label })
  } while (eat(','))
  let limit = Infinity
  if (keyword('LIMIT')) limit = int() ?? fail()
  if (toks[i].k !== 'eof') fail()
  return { chains, where: where.flatMap(conjuncts), items, distinct, limit, slots }
}

function conjuncts(e: Expr): Expr[] {
  const out: Expr[] = []
  const stack = [e]
  while (stack.length) {
    const x = stack.pop()!
    if (x.op === 'and') stack.push(x.b, x.a)
    else out.push(x)
  }
  return out
}

function slotsOf(e: Expr, out: number[] = []): number[] {
  if (e.op === 'var' || e.op === 'prop') out.push(e.slot)
  else if (e.op === 'list') for (const x of e.items) slotsOf(x, out)
  else if ('a' in e) {
    slotsOf(e.a, out)
    if ('b' in e) slotsOf(e.b, out)
  }
  return out
}

const isNode = (v: Val): v is GraphNode => typeof v === 'object' && v !== null && !Array.isArray(v) && 'values' in v
const isEdge = (v: Val): v is GraphEdge => typeof v === 'object' && v !== null && !Array.isArray(v) && 'source' in v

function prop(v: Val | undefined, name: string): Val {
  if (v === undefined || !(isNode(v) || isEdge(v))) return null
  if (isEdge(v)) {
    if (name === 'type') return v.type
    if (name === 'field') return v.field ?? null
    return null
  }
  switch (name) {
    case 'id':
      return v.id
    case 'type':
      return v.type
    case 'label':
      return v.label
    case 'field':
      return v.field ?? null
    case 'doi':
      return v.doi ?? null
    case 'year':
      return v.year ?? null
    case 'abstract':
      return v.abstract ?? null
  }
  if (!Object.hasOwn(v.values, name)) return null
  const list = v.values[name]
  return list.length === 1 ? list[0] : list
}

function eq(a: Val, b: Val): boolean | null {
  if (a === null || b === null) return null
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b
  if (a.length !== b.length) return false
  let out: boolean | null = true
  for (let k = 0; k < a.length; k++) {
    const r = eq(a[k], b[k])
    if (r === false) return false
    if (r === null) out = null
  }
  return out
}

function compare(op: string, a: Val, b: Val): Val {
  if (op === '=' || op === '<>') {
    const r = eq(a, b)
    return r === null ? null : r === (op === '=')
  }
  if (op === 'in') {
    if (!Array.isArray(b)) return null
    let out: boolean | null = false
    for (const x of b) {
      const r = eq(a, x)
      if (r) return true
      if (r === null) out = null
    }
    return out
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (op === 'contains') return a.includes(b)
    if (op === 'starts') return a.startsWith(b)
    if (op === 'ends') return a.endsWith(b)
  } else if (typeof a !== 'number' || typeof b !== 'number') return null
  if (op === '<') return a < b
  if (op === '<=') return a <= b
  if (op === '>') return a > b
  if (op === '>=') return a >= b
  return null
}

const truth = (v: Val) => (typeof v === 'boolean' ? v : null)

/** Stable identity key of a value, for DISTINCT and grouping. */
function key(v: Val): string {
  if (Array.isArray(v)) return `[${v.map(key).join(',')}]`
  if (isNode(v)) return `n${JSON.stringify(v.id)}`
  if (isEdge(v)) return `e${JSON.stringify([v.source, v.type, v.field ?? '', v.target])}`
  return `${typeof v}${JSON.stringify(v)}`
}

/** Display text of a result cell. */
export function formatValue(v: Val): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`
  if (isNode(v)) return v.label
  if (isEdge(v)) return v.field ? `${v.type} (${v.field})` : v.type
  return String(v)
}

export interface CypherResult {
  columns: string[]
  rows: Val[][]
  /** Ids of all nodes on matched paths and of the nodes in the returned values. */
  nodes: Set<string>
  seeds: Set<string>
  edges: Set<GraphEdge>
  truncated: boolean
}

const byTypeCache = new WeakMap<GraphIndex, Map<GraphNodeType, GraphNode[]>>()
function byType(index: GraphIndex) {
  let out = byTypeCache.get(index)
  if (!out) {
    out = new Map(NODE_LABELS.map((l) => [l, []]))
    for (const n of index.graph.nodes) out.get(n.type)?.push(n)
    byTypeCache.set(index, out)
  }
  return out
}

interface Step {
  from: number
  used: Set<GraphEdge>
  rel?: RelPat
  to: NodePat
  filters: Expr[]
}

/** Runs a parsed query; stops at MAX_ROWS rows, the LIMIT or MAX_WORK steps of work. */
export function runCypher(index: GraphIndex, q: CypherQuery): CypherResult {
  const types = byType(index)
  const candidates = (label?: GraphNodeType) => (label ? types.get(label)! : index.graph.nodes)
  const bound = new Set<number>()
  const steps: Step[] = []
  const boundAt: number[] = []
  const used = new Map<number, Set<GraphEdge>>()
  for (const c of q.chains) {
    let { nodes, rels } = c
    if (!used.has(c.clause)) used.set(c.clause, new Set())
    const clauseUsed = used.get(c.clause)!
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const reverse =
      !bound.has(first.slot) && (bound.has(last.slot) || candidates(last.label).length < candidates(first.label).length)
    if (reverse) {
      nodes = [...nodes].reverse()
      rels = [...rels].reverse().map((r) => ({ ...r, dir: -r.dir as RelPat['dir'], flip: true }))
    }
    const mark = (slot: number) => {
      if (!bound.has(slot)) boundAt[slot] = steps.length - 1
      bound.add(slot)
    }
    steps.push({ from: -1, used: clauseUsed, to: nodes[0], filters: [] })
    mark(nodes[0].slot)
    rels.forEach((rel, r) => {
      steps.push({ from: nodes[r].slot, used: clauseUsed, rel, to: nodes[r + 1], filters: [] })
      mark(rel.slot)
      mark(nodes[r + 1].slot)
    })
  }
  for (const f of q.where) steps[Math.max(0, ...slotsOf(f).map((s) => boundAt[s]))].filters.push(f)

  const env: (Val | undefined)[] = new Array(q.slots.length)
  const aggregate = q.items.some((it) => it.expr.op === 'count')
  const cap = Math.min(q.limit, MAX_ROWS)
  const rows: Val[][] = []
  const groups = new Map<string, Val[]>()
  const seen = new Set<string>()
  const nodes = new Set<string>()
  const seeds = new Set<string>()
  const edges = new Set<GraphEdge>()
  let truncated = false
  let work = 0
  const STOP = new Error('stop')

  const ev = (e: Expr): Val => {
    switch (e.op) {
      case 'lit':
        return e.v
      case 'list':
        return e.items.map(ev)
      case 'var':
        return env[e.slot] ?? null
      case 'prop':
        return prop(env[e.slot], e.name)
      case 'not': {
        const a = truth(ev(e.a))
        return a === null ? null : !a
      }
      case 'and':
      case 'or': {
        const stop = e.op === 'or'
        const a = truth(ev(e.a))
        if (a === stop) return stop
        const b = truth(ev(e.b))
        return b === stop ? stop : a === null || b === null ? null : !stop
      }
      case 'null':
        return (ev(e.a) === null) !== e.negate
      case 'cmp':
        return compare(e.cmp!, ev(e.a), ev(e.b))
      default:
        return null
    }
  }
  const seed = (v: Val) => {
    if (Array.isArray(v)) v.forEach(seed)
    else if (isNode(v)) seeds.add(v.id)
  }
  const stop = (): never => {
    truncated = true
    throw STOP
  }
  const emit = () => {
    const row = q.items.map((it) => (it.expr.op === 'count' ? 1 : ev(it.expr)))
    const k = q.distinct || aggregate ? JSON.stringify(row.map(key)) : ''
    const group = aggregate ? groups.get(k) : undefined
    if (group) {
      q.items.forEach((it, c) => {
        if (it.expr.op === 'count') group[c] = (group[c] as number) + 1
      })
    } else if (aggregate) {
      if (groups.size === MAX_ROWS) stop()
      groups.set(k, row)
      rows.push(row)
    } else if (!q.distinct || !seen.has(k)) {
      if (rows.length === cap) stop()
      seen.add(k)
      rows.push(row)
    }
    q.slots.forEach((kind, s) => {
      const v = env[s]
      if (kind === 'node') nodes.add((v as GraphNode).id)
      else if (kind === 'rel') edges.add(v as GraphEdge)
      else for (const x of v as GraphEdge[]) edges.add(x)
    })
    if (!aggregate && rows.length === cap && q.limit <= MAX_ROWS) throw STOP
  }
  const follow = (e: GraphEdge, id: string, rel: RelPat): GraphNode | undefined => {
    if (rel.types && !rel.types.has(e.type)) return undefined
    if (rel.dir === 1 && e.source !== id) return undefined
    if (rel.dir === -1 && e.target !== id) return undefined
    return index.byId.get(e.source === id ? e.target : e.source)
  }
  const run = (s: number): void => {
    if (s === steps.length) return emit()
    const { from, used, rel, to, filters } = steps[s]
    const enter = (n: GraphNode, via?: GraphEdge | GraphEdge[]) => {
      if (++work > MAX_WORK) stop()
      if (to.label && n.type !== to.label) return
      const prev = env[to.slot]
      if (prev !== undefined && prev !== n) return
      env[to.slot] = n
      if (rel) env[rel.slot] = via
      if (filters.every((f) => ev(f) === true)) run(s + 1)
      env[to.slot] = prev
      if (rel) env[rel.slot] = undefined
    }
    if (!rel) {
      const prev = env[to.slot]
      if (prev !== undefined) enter(prev as GraphNode)
      else for (const n of candidates(to.label)) enter(n)
      return
    }
    const path: GraphEdge[] = []
    const walk = (n: GraphNode) => {
      if (rel.varLen && path.length >= rel.min) enter(n, rel.flip ? path.slice().reverse() : path.slice())
      if (path.length === rel.max) return
      for (const e of index.adjacent.get(n.id) ?? []) {
        if (++work > MAX_WORK) stop()
        const other = follow(e, n.id, rel)
        if (!other || used.has(e)) continue
        used.add(e)
        path.push(e)
        if (rel.varLen) walk(other)
        else enter(other, e)
        path.pop()
        used.delete(e)
      }
    }
    walk(env[from] as GraphNode)
  }

  try {
    if (cap > 0) run(0)
  } catch (e) {
    if (e !== STOP) throw e
  }
  if (aggregate && rows.length === 0 && q.items.every((it) => it.expr.op === 'count')) rows.push(q.items.map(() => 0))
  const out = rows.slice(0, cap)
  out.forEach((row) => row.forEach(seed))
  return { columns: q.items.map((it) => it.name), rows: out, nodes, seeds, edges, truncated }
}

/** A result as sent from the query worker: display rows, node ids and positions in `graph.edges`. */
export interface CypherOutput {
  columns: string[]
  rows: string[][]
  nodes: Set<string>
  seeds: Set<string>
  edges: Set<number>
  truncated: boolean
}
export type CypherRequest = { type: 'graph'; graph: Graph } | { type: 'query'; query: CypherQuery }
export type CypherReply = { out: CypherOutput } | { error: string }

// [impl->req~ui-250~1]
/** Runs queries message by message, in a worker or inline. Indexes each graph once; a query names no graph. */
export function cypherHost(post: (reply: CypherReply) => void) {
  let index: GraphIndex | undefined
  let position = new Map<GraphEdge, number>()
  return (m: CypherRequest) => {
    if (m.type === 'graph') {
      index = indexGraph(m.graph)
      position = new Map(m.graph.edges.map((e, i) => [e, i]))
      return
    }
    try {
      if (!index) throw new Error('no graph')
      const r = runCypher(index, m.query)
      const rows = r.rows.map((row) => row.map(formatValue))
      const edges = new Set([...r.edges].map((e) => position.get(e)!))
      post({ out: { columns: r.columns, rows, nodes: r.nodes, seeds: r.seeds, edges, truncated: r.truncated } })
    } catch (e) {
      post({ error: String(e) })
    }
  }
}

/** The matched paths as a sub-graph, plus the nodes the user revealed. */
export function cypherSubgraph(index: GraphIndex, result: CypherOutput, extra: Iterable<string> = []): SubGraph {
  const added = new Set([...extra].filter((id) => index.byId.has(id)))
  const keep = new Set([...result.nodes, ...added])
  return {
    nodes: index.graph.nodes.filter((n) => keep.has(n.id)),
    edges: index.graph.edges.filter(
      (e, i) => result.edges.has(i) || (keep.has(e.source) && keep.has(e.target) && (added.has(e.source) || added.has(e.target))),
    ),
    seeds: result.seeds,
  }
}
