// [utest->req~ui-260~1]
import { describe, it, expect } from 'vitest'
import type { GraphEdgeType, GraphNode } from '../model/graph'
import type { SubGraph } from '../model/graphQuery'
import { buildScene, EDGE_TYPES, type Scene } from './graphCanvas'
import { imageFrame, MAX_SIDE, sceneToSvg } from './graphImage'

const node = (id: string, label = id): GraphNode => ({ id, type: 'Paper', label, values: {} })
const PALETTE = { edges: ['#e0', '#e1', '#e2', '#e3', '#e4'], text: '#t', selected: '#s', groups: ['#g0', '#g1', '#g2', '#g3'] }

function scene(nodes: GraphNode[], edges: [string, string, GraphEdgeType][], ...pos: [number, number][]): Scene {
  const sub: SubGraph = { nodes, edges: edges.map(([source, target, type]) => ({ source, target, type })), seeds: new Set() }
  const s = buildScene(sub, false, null, () => [])
  pos.forEach(([x, y], i) => {
    s.xs[i] = x
    s.ys[i] = y
  })
  s.version++
  return s
}

describe('imageFrame', () => {
  it('keeps the current view for the visible area', () => {
    const s = scene([node('a')], [], [0, 0])
    expect(imageFrame(s, { x: 5, y: 6, k: 2 }, 300, 200, 'visible')).toEqual({ view: { x: 5, y: 6, k: 2 }, w: 300, h: 200 })
  })

  it('fits every placed node for the whole graph, whatever the view', () => {
    const s = scene([node('a'), node('b')], [], [0, 0], [1000, 500])
    const { view, w, h } = imageFrame(s, { x: 99, y: 99, k: 3 }, 10, 10, 'all')
    expect(view.k).toBe(1)
    expect([w, h]).toEqual([1080, 580])
    expect([view.x, view.y]).toEqual([40, 40])
  })

  it('scales a huge graph down to the maximum side', () => {
    const s = scene([node('a'), node('b')], [], [0, 0], [100000, 0])
    const { view, w } = imageFrame(s, { x: 0, y: 0, k: 1 }, 10, 10, 'all')
    expect(view.k).toBeLessThan(1)
    expect(w).toBeLessThanOrEqual(MAX_SIDE)
  })
})

describe('sceneToSvg', () => {
  const frame = { view: { x: 0, y: 0, k: 1 }, w: 400, h: 300 }

  it('escapes labels and the background', () => {
    const s = scene([node('a', '<b>&"x"')], [], [100, 100])
    const svg = sceneToSvg(s, { ...frame, view: { x: 0, y: 0, k: 1 } }, PALETTE, '"/><script>')
    expect(svg).not.toContain('<script>')
    expect(svg).not.toContain('<b>')
    expect(svg).toContain('&lt;b&gt;&amp;')
  })

  it('draws the shown edge types and omits the hidden ones', () => {
    const s = scene([node('a'), node('b')], [['a', 'b', EDGE_TYPES[0]]], [50, 50], [150, 50])
    expect(sceneToSvg(s, frame, PALETTE, '#fff')).toContain('stroke="#e0"')
    s.hidden = 1
    expect(sceneToSvg(s, frame, PALETTE, '#fff')).not.toContain('stroke="#e0"')
  })

  it('leaves out nodes outside the frame and ignores hover and selection', () => {
    const s = scene([node('a', 'in'), node('b', 'out')], [], [50, 50], [5000, 5000])
    s.hover = 0
    s.selected = 0
    const svg = sceneToSvg(s, frame, PALETTE, '#fff')
    expect(svg).toContain('>in<')
    expect(svg).not.toContain('>out<')
    expect(svg).not.toContain('#s')
  })
})
