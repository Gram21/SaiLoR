import type { Paper, Project } from './project'
import type { ResolvedDef } from './schema'
import { isField } from './schema'
import type { AnnotationValueTree, FieldValue } from './annotations'
import { hasAnnotations, isFieldVisible, isRecordedAnswer } from './annotations'

export type GraphNodeType = 'Paper' | 'Author' | 'Venue' | 'Keyword' | 'Choice' | 'Answer'
export type GraphEdgeType = 'authoredBy' | 'publishedIn' | 'hasKeyword' | 'cites' | 'hasAnswer'

export interface GraphNode {
  id: string
  type: GraphNodeType
  label: string
  field?: string
  doi?: string
  year?: number
  abstract?: string
  values: Record<string, string[]>
}

export interface GraphEdge {
  source: string
  target: string
  type: GraphEdgeType
  field?: string
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ')

const normDoi = (s: string) =>
  collapse(s)
    .toLowerCase()
    .replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/, '')

function strings(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw]
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

const isChoice = (def: ResolvedDef) =>
  def.type === 'boolean' || (def.type === 'string' && (def.options?.length ?? 0) > 0)

// [impl->req~dat-480~1]
export function buildGraph(
  project: Pick<Project, 'schema' | 'papers'>,
  trees: Record<string, AnnotationValueTree | undefined>,
): Graph {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()

  const node = (id: string, type: GraphNodeType, label: string, extra: Partial<GraphNode> = {}) => {
    let n = nodes.get(id)
    if (!n) {
      n = { id, type, label, ...extra, values: {} }
      nodes.set(id, n)
    }
    return n
  }
  const edge = (source: string, target: string, type: GraphEdgeType, field?: string) => {
    edges.set(JSON.stringify([source, type, field ?? '', target]), {
      source,
      target,
      type,
      ...(field !== undefined ? { field } : {}),
    })
  }
  const named = (prefix: string, type: GraphNodeType, raw: string): string | null => {
    const label = collapse(raw)
    if (!label) return null
    const n = node(`${prefix}:${label.normalize('NFC').toLowerCase()}`, type, label)
    if (byCodeUnit(label, n.label) < 0) n.label = label
    return n.id
  }

  const paperIds = new Map<string, string>()
  for (const p of project.papers) if (p.doi && normDoi(p.doi)) paperIds.set(`doi:${normDoi(p.doi)}`, `paper:${p.id}`)
  for (const p of project.papers) paperIds.set(`id:${p.id}`, `paper:${p.id}`)

  const literal = (owner: () => GraphNode, def: ResolvedDef, value: Exclude<FieldValue, null>) => {
    const text = String(value)
    if (isChoice(def)) {
      const id = `choice:${def.id}=${text}`
      node(id, 'Choice', text, { field: def.id })
      edge(owner().id, id, 'hasAnswer', def.id)
    } else {
      const values = owner().values
      ;(values[def.id] ??= []).push(text)
    }
  }

  const answerOwner = (parent: () => GraphNode, id: string, def: ResolvedDef, label: string) => () => {
    const existing = nodes.get(id)
    if (existing) return existing
    const made = node(id, 'Answer', label, { field: def.id })
    edge(parent().id, id, 'hasAnswer', def.id)
    return made
  }

  const walk = (
    defs: ResolvedDef[],
    tree: AnnotationValueTree,
    owner: () => GraphNode,
    path: string,
    ancestors: Record<string, FieldValue>,
    root: AnnotationValueTree,
  ) => {
    for (const def of defs) {
      if (!isFieldVisible(def, tree, ancestors, root)) continue
      const raw = tree[def.name]
      const instances = Array.isArray(raw) ? raw : []
      instances.forEach((inst, i) => {
        if (!inst || typeof inst !== 'object') return
        const here = `${path}/${def.name}#${i}`
        const target =
          def.children.length > 0 ? answerOwner(owner, `answer:${here}`, def, `${def.name} ${i + 1}`) : owner
        if (isField(def) && isRecordedAnswer(inst.value)) literal(target, def, inst.value as Exclude<FieldValue, null>)
        if (def.children.length > 0) {
          const children = inst.children && typeof inst.children === 'object' ? inst.children : {}
          const next = isField(def) ? { ...ancestors, [def.name]: inst.value ?? null } : ancestors
          walk(def.children, children, target, here, next, root)
        }
      })
    }
  }

  for (const p of project.papers) {
    const paper = node(`paper:${p.id}`, 'Paper', p.title, paperProps(p))
    for (const a of p.authors) {
      const id = named('author', 'Author', a)
      if (id) edge(paper.id, id, 'authoredBy')
    }
    if (p.venue) {
      const id = named('venue', 'Venue', p.venue)
      if (id) edge(paper.id, id, 'publishedIn')
    }
    for (const k of strings(p.extra.keywords).flatMap((s) => s.split(/[;,]/))) {
      const id = named('keyword', 'Keyword', k)
      if (id) edge(paper.id, id, 'hasKeyword')
    }
    for (const ref of strings(p.extra.references ?? p.extra.cites)) {
      const target = paperIds.get(`id:${collapse(ref)}`) ?? paperIds.get(`doi:${normDoi(ref)}`)
      if (target && target !== paper.id) edge(paper.id, target, 'cites')
    }
    const tree = trees[p.id] ?? {}
    walk(project.schema, tree, () => paper, p.id, {}, tree)
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => byCodeUnit(a.id, b.id)),
    edges: [...edges.entries()].sort(([a], [b]) => byCodeUnit(a, b)).map(([, e]) => e),
  }
}

function paperProps(p: Paper): Partial<GraphNode> {
  const out: Partial<GraphNode> = {}
  if (p.doi) out.doi = p.doi
  if (p.year !== undefined) out.year = p.year
  if (p.abstract) out.abstract = p.abstract
  return out
}

/** The seat value that selects the consolidated answers. */
export const CONSOLIDATION = 'consolidation'

type GraphProject = Pick<Project, 'reviewers' | 'schema' | 'papers'>

// [impl->req~dat-490~1]
export function hasConsolidation(project: GraphProject): boolean {
  return project.reviewers > 1 && project.papers.some((p) => hasAnnotations(project.schema, p.annotations ?? {}))
}

// [impl->req~dat-490~1]
/** The sources a user can pick: each reviewer seat, then the consolidation once one was saved. Empty with one reviewer. */
export function graphSeats(project: GraphProject): string[] {
  if (project.reviewers <= 1) return []
  const seats = Array.from({ length: project.reviewers }, (_, i) => String(i + 1))
  return hasConsolidation(project) ? [...seats, CONSOLIDATION] : seats
}

// [impl->req~dat-490~1]
/** The consolidation when one was saved, else seat 1. */
export function defaultGraphSeat(project: GraphProject): string {
  return hasConsolidation(project) ? CONSOLIDATION : '1'
}

// [impl->req~dat-490~1]
/** The answers of `seat` per paper. A project with one reviewer, or the seat `CONSOLIDATION`, reads the consolidated tree. */
export function graphTrees(project: GraphProject, seat: string): Record<string, AnnotationValueTree> {
  const consolidated = project.reviewers <= 1 || seat === CONSOLIDATION
  const out: Record<string, AnnotationValueTree> = {}
  for (const p of project.papers) out[p.id] = (consolidated ? p.annotations : p.reviews[seat]) ?? {}
  return out
}

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  schema: 'https://schema.org/',
  dcterms: 'http://purl.org/dc/terms/',
  sailor: 'https://github.com/Gram21/SaiLoR/ns#',
} as const

type Term = { iri: string } | { lit: string; dt?: string }
type Triple = [string, string, Term]

const RDF_TYPE = `${NS.rdf}type`

const encode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

function nodeIri(id: string): string {
  const at = id.indexOf(':')
  return `urn:sailor:${id.slice(0, at)}:${encode(id.slice(at + 1))}`
}

const fieldIri = (field: string) => `${NS.sailor}field/${encode(field)}`

const NODE_CLASS: Record<GraphNodeType, string> = {
  Paper: `${NS.schema}ScholarlyArticle`,
  Author: `${NS.schema}Person`,
  Venue: `${NS.sailor}Venue`,
  Keyword: `${NS.sailor}Keyword`,
  Choice: `${NS.sailor}Choice`,
  Answer: `${NS.sailor}Answer`,
}

const EDGE_PROPERTY: Record<Exclude<GraphEdgeType, 'hasAnswer'>, string> = {
  authoredBy: `${NS.dcterms}creator`,
  publishedIn: `${NS.dcterms}isPartOf`,
  hasKeyword: `${NS.dcterms}subject`,
  cites: `${NS.dcterms}references`,
}

function valueFields(graph: Graph): string[] {
  return [...new Set(graph.nodes.flatMap((n) => Object.keys(n.values)))].sort(byCodeUnit)
}

function triples(graph: Graph): Triple[] {
  const out: Triple[] = []
  const fields = new Set([...valueFields(graph), ...graph.edges.flatMap((e) => (e.field ? [e.field] : []))])
  for (const f of [...fields].sort(byCodeUnit)) {
    out.push([fieldIri(f), RDF_TYPE, { iri: `${NS.rdf}Property` }])
    out.push([fieldIri(f), `${NS.rdfs}subPropertyOf`, { iri: `${NS.sailor}hasAnswer` }])
    out.push([fieldIri(f), `${NS.rdfs}label`, { lit: f }])
  }
  const outgoing = new Map<string, GraphEdge[]>()
  for (const e of graph.edges) outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e])
  for (const n of graph.nodes) {
    const s = nodeIri(n.id)
    out.push([s, RDF_TYPE, { iri: NODE_CLASS[n.type] }])
    if (n.type === 'Paper') {
      out.push([s, `${NS.dcterms}title`, { lit: n.label }])
      if (n.year !== undefined) {
        const year = String(n.year)
        out.push([s, `${NS.dcterms}issued`, /^\d{4}$/.test(year) ? { lit: year, dt: `${NS.xsd}gYear` } : { lit: year }])
      }
      if (n.doi) out.push([s, `${NS.dcterms}identifier`, { lit: n.doi }])
      if (n.abstract) out.push([s, `${NS.dcterms}abstract`, { lit: n.abstract }])
    } else if (n.type === 'Author') {
      out.push([s, `${NS.schema}name`, { lit: n.label }])
    } else {
      out.push([s, `${NS.rdfs}label`, { lit: n.label }])
    }
    if (n.field) out.push([s, `${NS.sailor}field`, { lit: n.field }])
    for (const f of Object.keys(n.values).sort(byCodeUnit)) {
      for (const v of n.values[f]) out.push([s, fieldIri(f), { lit: v }])
    }
    for (const e of outgoing.get(n.id) ?? []) {
      const p = e.type === 'hasAnswer' ? fieldIri(e.field ?? '') : EDGE_PROPERTY[e.type]
      out.push([s, p, { iri: nodeIri(e.target) }])
    }
  }
  return out
}

function compact(iri: string): string | null {
  for (const [prefix, ns] of Object.entries(NS)) {
    if (iri.startsWith(ns) && /^[A-Za-z][A-Za-z0-9_-]*$/.test(iri.slice(ns.length))) {
      return `${prefix}:${iri.slice(ns.length)}`
    }
  }
  return null
}

// [impl->req~dat-510~1]
export function turtleString(s: string): string {
  const escaped = s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
    switch (c) {
      case '\\':
        return '\\\\'
      case '"':
        return '\\"'
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      case '\t':
        return '\\t'
      default:
        return `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
    }
  })
  return `"${escaped}"`
}

// [impl->req~dat-500~1]
export function toTurtle(graph: Graph): string {
  const iri = (i: string) => compact(i) ?? `<${i}>`
  const term = (o: Term) => ('iri' in o ? iri(o.iri) : turtleString(o.lit) + (o.dt ? `^^${iri(o.dt)}` : ''))
  const lines = Object.entries(NS).map(([prefix, ns]) => `@prefix ${prefix}: <${ns}> .`)
  let subject: string | null = null
  for (const [s, p, o] of triples(graph)) {
    const pred = p === RDF_TYPE ? 'a' : iri(p)
    if (s === subject) {
      lines[lines.length - 1] += ' ;'
      lines.push(`    ${pred} ${term(o)}`)
    } else {
      if (subject !== null) lines[lines.length - 1] += ' .'
      lines.push('', `${iri(s)} ${pred} ${term(o)}`)
      subject = s
    }
  }
  if (subject !== null) lines[lines.length - 1] += ' .'
  return lines.join('\n') + '\n'
}

// [impl->req~dat-500~1]
export function toJsonLd(graph: Graph): string {
  const iri = (i: string) => compact(i) ?? i
  const subjects = new Map<string, Record<string, unknown[]>>()
  for (const [s, p, o] of triples(graph)) {
    let entry = subjects.get(s)
    if (!entry) {
      entry = {}
      subjects.set(s, entry)
    }
    const key = p === RDF_TYPE ? '@type' : iri(p)
    const value =
      p === RDF_TYPE && 'iri' in o
        ? iri(o.iri)
        : 'iri' in o
          ? { '@id': iri(o.iri) }
          : o.dt
            ? { '@value': o.lit, '@type': iri(o.dt) }
            : o.lit
    ;(entry[key] ??= []).push(value)
  }
  const doc = {
    '@context': NS,
    '@graph': [...subjects].map(([s, props]) => ({ '@id': iri(s), ...props })),
  }
  return JSON.stringify(doc, null, 2) + '\n'
}

// [impl->req~dat-510~1]
export function xmlText(s: string): string {
  return s
    .replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c)
}

// [impl->req~dat-500~1]
export function toGraphMl(graph: Graph): string {
  const fields = valueFields(graph)
  const key = (id: string, target: string, name: string) =>
    `  <key id="${id}" for="${target}" attr.name="${xmlText(name)}" attr.type="string"/>`
  const data = (k: string, v: string | undefined) => (v === undefined ? [] : [`      <data key="${k}">${xmlText(v)}</data>`])
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    key('type', 'node', 'type'),
    key('label', 'node', 'label'),
    key('field', 'node', 'field'),
    key('doi', 'node', 'doi'),
    key('year', 'node', 'year'),
    key('abstract', 'node', 'abstract'),
    ...fields.map((f, i) => key(`v${i}`, 'node', f)),
    key('etype', 'edge', 'type'),
    key('efield', 'edge', 'field'),
    '  <graph id="G" edgedefault="directed">',
  ]
  for (const n of graph.nodes) {
    lines.push(
      `    <node id="${xmlText(n.id)}">`,
      ...data('type', n.type),
      ...data('label', n.label),
      ...data('field', n.field),
      ...data('doi', n.doi),
      ...data('year', n.year === undefined ? undefined : String(n.year)),
      ...data('abstract', n.abstract),
      ...fields.flatMap((f, i) => data(`v${i}`, n.values[f]?.join('; '))),
      '    </node>',
    )
  }
  for (const e of graph.edges) {
    lines.push(
      `    <edge source="${xmlText(e.source)}" target="${xmlText(e.target)}">`,
      ...data('etype', e.type),
      ...data('efield', e.field),
      '    </edge>',
    )
  }
  lines.push('  </graph>', '</graphml>')
  return lines.join('\n') + '\n'
}

// [impl->req~dat-510~1]
export function csvCell(s: string): string {
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

export const csv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

// [impl->req~dat-500~1]
export function toCsvNodes(graph: Graph): string {
  const fields = valueFields(graph)
  return csv([
    ['id', 'type', 'label', 'field', 'doi', 'year', 'abstract', ...fields],
    ...graph.nodes.map((n) => [
      n.id,
      n.type,
      n.label,
      n.field ?? '',
      n.doi ?? '',
      n.year === undefined ? '' : String(n.year),
      n.abstract ?? '',
      ...fields.map((f) => n.values[f]?.join('; ') ?? ''),
    ]),
  ])
}

// [impl->req~dat-500~1]
export function toCsvEdges(graph: Graph): string {
  return csv([['source', 'target', 'type', 'field'], ...graph.edges.map((e) => [e.source, e.target, e.type, e.field ?? ''])])
}
