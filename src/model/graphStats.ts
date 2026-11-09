import type { Graph, GraphNode, GraphNodeType } from './graph'

export interface GraphStats {
  nodes: number
  edges: number
  byType: Partial<Record<GraphNodeType, number>>
  averageDegree: number
  components: number
  largest: number
  /** The best-connected nodes, most links first. */
  hubs: { node: GraphNode; degree: number }[]
}

export const HUBS = 5

// [impl->req~ui-360~1]
/** Counts, components and hubs of a graph. A node linked twice to the same node counts both links. */
export function graphStats(graph: Graph): GraphStats {
  const degree = new Map<string, number>()
  const parent = new Map<string, string>(graph.nodes.map((n) => [n.id, n.id]))
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    for (let at = id; at !== root; ) {
      const next = parent.get(at)!
      parent.set(at, root)
      at = next
    }
    return root
  }
  for (const e of graph.edges) {
    if (!parent.has(e.source) || !parent.has(e.target)) continue
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    if (e.target !== e.source) degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    parent.set(find(e.source), find(e.target))
  }
  const byType: GraphStats['byType'] = {}
  const sizes = new Map<string, number>()
  for (const n of graph.nodes) {
    byType[n.type] = (byType[n.type] ?? 0) + 1
    const root = find(n.id)
    sizes.set(root, (sizes.get(root) ?? 0) + 1)
  }
  const hubs = graph.nodes
    .map((node) => ({ node, degree: degree.get(node.id) ?? 0 }))
    .filter((h) => h.degree > 0)
    .sort((a, b) => b.degree - a.degree || a.node.label.localeCompare(b.node.label))
    .slice(0, HUBS)
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    byType,
    averageDegree: graph.nodes.length ? Math.round((2000 * graph.edges.length) / graph.nodes.length) / 1000 : 0,
    components: sizes.size,
    largest: Math.max(0, ...sizes.values()),
    hubs,
  }
}
