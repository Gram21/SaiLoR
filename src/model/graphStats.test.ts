import { describe, it, expect } from 'vitest'
import type { Graph, GraphNode } from './graph'
import { graphStats } from './graphStats'

const node = (id: string, type: GraphNode['type'] = 'Paper'): GraphNode => ({ id, type, label: id, values: {} }) as GraphNode
const edge = (source: string, target: string) => ({ source, target, type: 'cites' }) as Graph['edges'][number]

describe('graphStats', () => {
  // [utest->req~ui-360~1]
  it('counts nodes by type, components and hubs', () => {
    const g: Graph = {
      nodes: [node('a'), node('b'), node('c'), node('d', 'Author'), node('e', 'Author')],
      edges: [edge('a', 'b'), edge('a', 'c'), edge('d', 'a'), edge('e', 'e')],
    }
    const s = graphStats(g)
    expect(s).toMatchObject({ nodes: 5, edges: 4, byType: { Paper: 3, Author: 2 }, components: 2, largest: 4, averageDegree: 1.6 })
    expect(s.hubs.map((h) => [h.node.id, h.degree])).toEqual([['a', 3], ['b', 1], ['c', 1], ['d', 1], ['e', 1]])
  })

  // [utest->req~ui-360~1]
  it('handles an empty graph and ignores edges to unknown nodes', () => {
    expect(graphStats({ nodes: [], edges: [] })).toMatchObject({ nodes: 0, components: 0, largest: 0, averageDegree: 0, hubs: [] })
    expect(graphStats({ nodes: [node('a')], edges: [edge('a', 'x')] }).hubs).toEqual([])
  })
})
