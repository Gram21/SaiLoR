import type { Paper, Project } from './project'
import type { ResolvedDef } from './schema'
import { isField } from './schema'
import type { AnnotationValueTree } from './annotations'
import { buildGraph, csvCell, type Graph, type GraphEdgeType } from './graph'
import { renderDiagram } from './diagramSvg'

export type ChartType = 'bar' | 'stacked' | 'line' | 'pie' | 'heatmap' | 'bubble'
export const CHART_TYPES: ChartType[] = ['bar', 'stacked', 'line', 'pie', 'heatmap', 'bubble']
export type SortOrder = 'count' | 'label'

/** Palettes of colour-blind safe colours (Okabe-Ito first). */
export const PALETTES = {
  okabe: ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#d55e00', '#56b4e9', '#f0e442', '#000000'],
  tableau: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'],
  blues: ['#08306b', '#2171b5', '#4292c6', '#6baed6', '#9ecae1', '#c6dbef'],
  greens: ['#00441b', '#238b45', '#41ab5d', '#74c476', '#a1d99b', '#c7e9c0'],
  oranges: ['#7f2704', '#d94801', '#f16913', '#fd8d3c', '#fdae6b', '#fdd0a2'],
  purples: ['#3f007d', '#6a51a3', '#807dba', '#9e9ac8', '#bcbddc', '#dadaeb'],
  greys: ['#000000', '#252525', '#525252', '#737373', '#969696', '#bdbdbd'],
  viridis: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
  pastel: ['#a6cee3', '#b2df8a', '#fb9a99', '#fdbf6f', '#cab2d6', '#ffff99', '#b3cde3', '#ccebc5'],
  bold: ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#999999'],
} as const
export type PaletteName = keyof typeof PALETTES

export interface DiagramConfig {
  type: ChartType
  /** A dimension id: `@year`, `@venue`, `@author`, `@keyword` or `f:<schema field id>`. */
  x: string
  /** A dimension id that splits each category into series; empty for none. */
  group: string
  title: string
  xLabel: string
  yLabel: string
  palette: PaletteName
  /** Colours by series name, over the palette. */
  colors: Record<string, string>
  legend: boolean
  /** The most characters of a label on the horizontal axis; 0 for the full label. */
  xLabelChars: number
  /** The most characters of a label on the vertical axis; 0 for the full label. */
  yLabelChars: number
  values: boolean
  sort: SortOrder
  /** The most categories and series shown; the rest becomes "Other". */
  limit: number
  /** Count the papers without a value as one category. */
  empty: boolean
  /** Draw bars from the left, for long category names. Bar and stacked bar only. */
  horizontal: boolean
  /** Show each stacked bar as shares of 100 %. */
  percent: boolean
  /** A dimension id; with `filterText`, only the papers that have a matching value are counted. Empty for no filter. */
  filterDim: string
  filterText: string
  width: number
  height: number
}

export const DEFAULT_CONFIG: DiagramConfig = {
  type: 'bar',
  x: '@year',
  group: '',
  title: '',
  xLabel: '',
  yLabel: '',
  palette: 'okabe',
  colors: {},
  legend: true,
  xLabelChars: 0,
  yLabelChars: 0,
  values: true,
  sort: 'label',
  limit: 12,
  empty: false,
  horizontal: false,
  percent: false,
  filterDim: '',
  filterText: '',
  width: 800,
  height: 500,
}

export const BUILTIN_DIMENSIONS = ['@year', '@venue', '@author', '@keyword'] as const
export const OTHER = 'Other'
export const NONE = '(none)'

export interface Dimension {
  id: string
  /** The schema path, shown as is; empty for a built-in dimension. */
  label: string
}

/** The fields of the schema that a diagram can count, by path. */
export function schemaDimensions(schema: ResolvedDef[]): Dimension[] {
  const out: Dimension[] = []
  const walk = (defs: ResolvedDef[], path: string[]) => {
    for (const def of defs) {
      const here = [...path, def.name]
      if (isField(def)) out.push({ id: `f:${def.id}`, label: here.join(' › ') })
      walk(def.children, here)
    }
  }
  walk(schema, [])
  return out
}

export interface DiagramData {
  /** The categories of `x`, in display order. */
  cats: string[]
  /** The series; one, named "", without a group. */
  series: string[]
  /** Papers per category (row) and series (column). */
  counts: number[][]
  /** The papers counted. */
  papers: number
}

const BUILTIN_EDGE: Record<string, GraphEdgeType> = { '@venue': 'publishedIn', '@author': 'authoredBy', '@keyword': 'hasKeyword' }

/** The distinct values of `dim` per paper node id, read from the knowledge graph. */
export function paperValues(graph: Graph, dim: string): Map<string, string[]> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const out = new Map<string, string[]>()
  const answers = new Map<string, string[]>()
  const direct = new Map<string, string[]>()
  const field = dim.startsWith('f:') ? dim.slice(2) : null
  for (const e of graph.edges) {
    const list = e.type === 'hasAnswer' ? answers : e.type === BUILTIN_EDGE[dim] ? direct : null
    if (list) (list.get(e.source) ?? list.set(e.source, []).get(e.source)!).push(e.target)
  }
  for (const n of graph.nodes) {
    if (n.type !== 'Paper') continue
    const found = new Set<string>()
    if (dim === '@year') {
      if (n.year !== undefined) found.add(String(n.year))
    } else if (field === null) {
      for (const id of direct.get(n.id) ?? []) found.add(byId.get(id)!.label)
    } else {
      const seen = new Set<string>()
      const stack = [n.id]
      while (stack.length) {
        const id = stack.pop()!
        if (seen.has(id)) continue
        seen.add(id)
        const cur = byId.get(id)!
        if (cur.type === 'Choice') {
          if (cur.field === field) found.add(cur.label)
          continue
        }
        for (const v of cur.values[field] ?? []) found.add(v)
        stack.push(...(answers.get(id) ?? []))
      }
    }
    out.set(n.id, [...found])
  }
  return out
}

const numeric = (s: string) => s.trim() !== '' && Number.isFinite(Number(s))
const natural = (a: string, b: string) => (numeric(a) && numeric(b) ? Number(a) - Number(b) : a.localeCompare(b, undefined, { numeric: true }))

/** The `limit` biggest keys by `weight`, with the rest merged into OTHER; the kept keys keep their order. */
function topKeys(keys: string[], weight: Map<string, number>, limit: number): string[] {
  if (keys.length <= limit) return keys
  const keep = new Set([...keys].sort((a, b) => weight.get(b)! - weight.get(a)! || natural(a, b)).slice(0, Math.max(1, limit - 1)))
  return [...keys.filter((k) => keep.has(k)), OTHER]
}

// [impl->req~ui-290~1]
// [impl->req~ui-330~1]
export function aggregate(graph: Graph, config: Pick<DiagramConfig, 'x' | 'group' | 'sort' | 'limit' | 'empty' | 'type'> & Partial<Pick<DiagramConfig, 'filterDim' | 'filterText'>>): DiagramData {
  const xs = paperValues(graph, config.x)
  const needle = (config.filterText ?? '').trim().toLowerCase()
  const filter = config.filterDim && needle ? paperValues(graph, config.filterDim) : null
  const gs = config.group ? paperValues(graph, config.group) : null
  const cell = new Map<string, number>()
  const xTotal = new Map<string, number>()
  const gTotal = new Map<string, number>()
  const key = (x: string, g: string) => JSON.stringify([x, g])
  let papers = 0
  for (const [id, xv] of xs) {
    if (filter && !filter.get(id)!.some((v) => v.toLowerCase().includes(needle))) continue
    const xl = xv.length ? xv : config.empty ? [NONE] : []
    const gv = gs ? (gs.get(id)!.length ? gs.get(id)! : config.empty ? [NONE] : []) : ['']
    if (!xl.length || !gv.length) continue
    papers++
    for (const x of xl) {
      xTotal.set(x, (xTotal.get(x) ?? 0) + 1)
      for (const g of gv) {
        cell.set(key(x, g), (cell.get(key(x, g)) ?? 0) + 1)
        if (xl[0] === x) gTotal.set(g, (gTotal.get(g) ?? 0) + 1)
      }
    }
  }
  const ordered = [...xTotal.keys()].sort(
    config.sort === 'count' && config.type !== 'line' ? (a, b) => xTotal.get(b)! - xTotal.get(a)! || natural(a, b) : natural,
  )
  const cats = topKeys(ordered, xTotal, config.limit)
  const series = topKeys([...gTotal.keys()].sort(natural), gTotal, config.limit)
  const cIndex = new Map(cats.map((c, i) => [c, i]))
  const sIndex = new Map(series.map((s, i) => [s, i]))
  const counts = cats.map(() => series.map(() => 0))
  for (const [k, n] of cell) {
    const [x, g] = JSON.parse(k) as [string, string]
    counts[cIndex.get(x) ?? cIndex.get(OTHER)!][sIndex.get(g) ?? sIndex.get(OTHER)!] += n
  }
  return { cats, series, counts, papers }
}

// [impl->req~ui-340~1]
/** The counts as CSV: one row per category, one column per series. */
export function diagramCsv(data: DiagramData, xLabel: string, valueLabel: string): string {
  const head = [xLabel, ...data.series.map((s) => s || valueLabel)]
  const rows = data.cats.map((c, i) => [c, ...data.counts[i].map(String)])
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export type DiagramRequest =
  | { type: 'data'; project: Pick<Project, 'schema' | 'papers'>; trees: Record<string, AnnotationValueTree | undefined> }
  | { type: 'render'; id: number; config: DiagramConfig }
export type DiagramReply = { id: number; svg: string; keys: string[]; categories: number; papers: number; data: DiagramData } | { id: number; error: string }

/** The request without the parts a diagram never reads: abstracts, annotations and reviews. Smaller to copy to a worker. */
export const slimProject = (project: Pick<Project, 'schema' | 'papers'>): Pick<Project, 'schema' | 'papers'> => ({
  schema: project.schema,
  papers: project.papers.map((p) => ({ ...p, abstract: undefined, annotations: undefined, reviews: {} }) as unknown as Paper),
})

/** Builds the graph once per `data` message, then aggregates and renders per `render` message; in a worker or inline. */
export function diagramHost(post: (reply: DiagramReply) => void) {
  let graph: Graph | undefined
  return (m: DiagramRequest) => {
    if (m.type === 'data') {
      graph = buildGraph(m.project, m.trees)
      return
    }
    try {
      if (!graph) throw new Error('No data')
      const data = aggregate(graph, m.config)
      post({ id: m.id, svg: renderDiagram(data, m.config), keys: m.config.type === 'pie' ? data.cats : data.series, categories: data.cats.length, papers: data.papers, data })
    } catch (e) {
      post({ id: m.id, error: String(e) })
    }
  }
}
