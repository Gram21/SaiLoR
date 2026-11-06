// [utest->req~ui-210~1]
import { describe, it, expect, vi } from 'vitest'
import type { GraphNode, GraphNodeType } from '../model/graph'
import type { SubGraph } from '../model/graphQuery'
import { buildScene, cull, drawScene, fitView, hitTest, LABEL_MAX, MAX_ZOOM, MIN_ZOOM, showLabels, zoomAt, type Scene, type View } from './graphCanvas'

const TYPES: GraphNodeType[] = ['Paper', 'Author', 'Venue', 'Keyword', 'Choice', 'Answer']
const node = (id: string, type: GraphNodeType = 'Paper', label = id): GraphNode => ({ id, type, label, values: {} })

function sub(nodes: GraphNode[], edges: [string, string][] = [], seeds: string[] = []): SubGraph {
  return { nodes, edges: edges.map(([source, target]) => ({ source, target, type: 'cites' })), seeds: new Set(seeds) }
}

function place(scene: Scene, ...pos: [number, number][]) {
  pos.forEach(([x, y], i) => {
    scene.xs[i] = x
    scene.ys[i] = y
  })
  scene.version++
  return scene
}

/** Counts the calls of the canvas methods that drawScene uses. */
function mockContext() {
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    rect: vi.fn(),
    arc: vi.fn(),
    fillText: vi.fn(),
  }
  return ctx as typeof ctx & CanvasRenderingContext2D
}
const PALETTE = { edge: 'e', text: 't', selected: 's', groups: ['0', '1', '2', '3'] }

describe('buildScene', () => {
  it('keeps the positions of staying nodes and places new nodes next to a placed neighbour', () => {
    const first = place(buildScene(sub([node('a'), node('b')]), false, null, () => []), [1, 2], [3, 4])
    const next = buildScene(
      sub([node('b'), node('c', 'Author', 'A very long author name that is cut off'), node('d', 'Choice')], [['b', 'c']], ['c']),
      true,
      first,
      (id) => (id === 'c' ? ['x', 'b'] : []),
    )
    expect(next.ids).toEqual(['b', 'c', 'd'])
    expect([...next.xs]).toEqual([3, 13, NaN])
    expect([...next.ys]).toEqual([4, 14, NaN])
    expect([...next.edges]).toEqual([0, 1])
    expect([...next.group]).toEqual([0, 1, 3])
    expect([...next.match]).toEqual([0, 1, 0])
    expect(next.labels[1]).toBe('A very long author name tha…')
    expect(buildScene(sub([node('c')], [], ['c']), false, null, () => []).match[0]).toBe(0)
  })
})

describe('cull', () => {
  it('lists only the placed nodes inside the viewport and its padding', () => {
    const scene = place(buildScene(sub([node('a'), node('b'), node('c'), node('d')]), false, null, () => []), [0, 0], [130, 0], [-90, 50], [NaN, NaN])
    const view = { x: 100, y: 100, k: 1 }
    expect([...scene.visible.subarray(0, cull(scene, view, 200, 200))]).toEqual([0, 2])
    expect(cull(scene, view, 200, 200, 40)).toBe(3)
    expect(cull(scene, { x: 0, y: 0, k: 0.5 }, 200, 200, 0)).toBe(2)
  })
})

describe('showLabels', () => {
  it('shows labels only when zoomed in and not too many nodes are visible', () => {
    expect(showLabels(1, 10)).toBe(true)
    expect(showLabels(0.5, 10)).toBe(false)
    expect(showLabels(1, LABEL_MAX + 1)).toBe(false)
  })
})

describe('drawScene', () => {
  const scene = () => {
    const s = place(
      buildScene(sub([node('a'), node('b', 'Author'), node('c', 'Keyword'), node('far')], [['a', 'b'], ['b', 'far'], ['far', 'far']], ['a']), true, null, () => []),
      [0, 0],
      [50, 0],
      [0, 50],
      [5000, 5000],
    )
    s.selected = 1
    return s
  }

  it('batches edges in one path and nodes in one path per colour, culls and labels when zoomed in', () => {
    const ctx = mockContext()
    drawScene(ctx, scene(), { x: 100, y: 100, k: 1 }, 300, 300, 2, PALETTE)
    expect(ctx.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 200, 200)
    expect(ctx.lineTo).toHaveBeenCalledTimes(2)
    expect(ctx.fill).toHaveBeenCalledTimes(4)
    expect(ctx.stroke).toHaveBeenCalledTimes(3)
    expect(ctx.arc).toHaveBeenCalledTimes(3 + 1 + 1)
    expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c'])
    expect(ctx.fillText).toHaveBeenCalledWith('b', 50, -12)
  })

  it('draws small squares and no labels when zoomed out', () => {
    const ctx = mockContext()
    drawScene(ctx, scene(), { x: 0, y: 0, k: 0.1 }, 300, 300, 1, PALETTE)
    expect(ctx.arc).toHaveBeenCalledTimes(2)
    expect(ctx.rect).toHaveBeenCalledTimes(3)
    expect(ctx.rect).toHaveBeenCalledWith(-10, -10, 20, 20)
    expect(ctx.fillText).not.toHaveBeenCalled()
  })

  it('skips the selection ring of an unplaced node', () => {
    const ctx = mockContext()
    const s = buildScene(sub([node('a')]), false, null, () => [])
    s.selected = 0
    drawScene(ctx, s, { x: 0, y: 0, k: 1 }, 100, 100, 1, PALETTE)
    expect(ctx.arc).not.toHaveBeenCalled()
  })
})

describe('hitTest', () => {
  it('finds the nearest node within reach and rebuilds the index after a move', () => {
    const scene = place(buildScene(sub([node('a'), node('b')]), false, null, () => []), [0, 0], [100, 0])
    expect(hitTest(scene, 5, 5, 1)).toBe(0)
    expect(hitTest(scene, 50, 0, 1)).toBe(-1)
    expect(hitTest(scene, 50, 0, 0.05)).toBe(0)
    place(scene, [0, 0], [50, 2])
    expect(hitTest(scene, 50, 0, 1)).toBe(1)
  })
})

describe('zoomAt and fitView', () => {
  it('zooms around a point and clamps the zoom', () => {
    const v: View = { x: 0, y: 0, k: 1 }
    zoomAt(v, 100, 50, 2)
    expect(v).toEqual({ x: -100, y: -50, k: 2 })
    zoomAt(v, 0, 0, 100)
    expect(v.k).toBe(MAX_ZOOM)
    zoomAt(v, 0, 0, 1e-9)
    expect(v.k).toBe(MIN_ZOOM)
  })

  it('fits the placed nodes, never zooms in past 1 and centres the origin without positions', () => {
    const v: View = { x: 0, y: 0, k: 3 }
    fitView(v, null, 200, 100)
    expect(v).toEqual({ x: 100, y: 50, k: 1 })
    const scene = place(buildScene(sub([node('a'), node('b'), node('c')]), false, null, () => []), [-1000, 0], [1000, 100], [NaN, NaN])
    fitView(v, scene, 400, 400)
    expect(v.k).toBeCloseTo(400 / 2080)
    expect(v.x).toBeCloseTo(200)
    expect(v.y).toBeCloseTo(200 - 50 * v.k)
    fitView(v, scene, 0, 0)
    expect(v.k).toBe(1)
  })
})

/** SLR-like graph: one in ten nodes is a paper with links to five other nodes. */
function bigScene(n: number): Scene {
  let seed = 7
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const nodes = Array.from({ length: n }, (_, i) => node(`n${i}`, i % 10 === 0 ? 'Paper' : TYPES[1 + (i % 5)], `Node number ${i}`))
  const edges: [string, string][] = []
  for (let i = 0; i < n; i += 10) for (let e = 0; e < 5 * 2; e++) edges.push([`n${i}`, `n${Math.floor(rand() * n)}`])
  const scene = buildScene(sub(nodes, edges, nodes.slice(0, n / 10).map((x) => x.id)), true, null, () => [])
  const side = Math.sqrt(n) * 30
  for (let i = 0; i < n; i++) {
    scene.xs[i] = rand() * side - side / 2
    scene.ys[i] = rand() * side - side / 2
  }
  return scene
}

// Budgets are about 10× the times measured on a laptop, so slow CI runners do not fail them.
describe.each([10_000, 50_000])('canvas performance with %i nodes', (n) => {
  const scene = bigScene(n)
  const ctx = mockContext()
  const ms = (f: () => void, runs = 5) => {
    const t0 = performance.now()
    for (let i = 0; i < runs; i++) f()
    return (performance.now() - t0) / runs
  }

  it('builds the scene', () => {
    expect(ms(() => bigScene(n), 1)).toBeLessThan(n / 10)
  })

  it('culls and draws a zoomed-out frame of the whole graph', () => {
    const view = { x: 500, y: 400, k: 800 / (Math.sqrt(n) * 30) }
    expect(cull(scene, view, 1000, 800)).toBe(n)
    expect(ms(() => cull(scene, view, 1000, 800))).toBeLessThan(50)
    expect(ms(() => drawScene(ctx, scene, view, 1000, 800, 2, PALETTE))).toBeLessThan(n / 50)
  })

  it('culls a zoomed-in frame with labels', () => {
    const view = { x: 500, y: 400, k: 1 }
    expect(ms(() => drawScene(ctx, scene, view, 1000, 800, 2, PALETTE))).toBeLessThan(n / 100)
  })

  it('answers hit tests', () => {
    scene.version++
    const t = ms(() => hitTest(scene, 0, 0, 1), 1)
    expect(t).toBeLessThan(n / 50)
    expect(ms(() => hitTest(scene, 10, 10, 1), 1000)).toBeLessThan(1)
  })
})
