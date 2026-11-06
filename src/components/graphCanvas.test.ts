// [utest->req~ui-210~1]
// [utest->req~ui-220~1]
import { describe, it, expect, vi } from 'vitest'
import type { GraphEdgeType, GraphNode, GraphNodeType } from '../model/graph'
import type { SubGraph } from '../model/graphQuery'
import {
  buildScene,
  cull,
  drawScene,
  edgeAt,
  EDGE_TYPES,
  fitView,
  hitTest,
  LABEL_MAX,
  MAX_ZOOM,
  MIN_ZOOM,
  selectNode,
  showLabels,
  zoomAt,
  type Scene,
  type View,
} from './graphCanvas'

const TYPES: GraphNodeType[] = ['Paper', 'Author', 'Venue', 'Keyword', 'Choice', 'Answer']
const node = (id: string, type: GraphNodeType = 'Paper', label = id): GraphNode => ({ id, type, label, values: {} })

function sub(nodes: GraphNode[], edges: [string, string, GraphEdgeType?][] = [], seeds: string[] = []): SubGraph {
  return { nodes, edges: edges.map(([source, target, type = 'cites']) => ({ source, target, type })), seeds: new Set(seeds) }
}

function place(scene: Scene, ...pos: [number, number][]) {
  pos.forEach(([x, y], i) => {
    scene.xs[i] = x
    scene.ys[i] = y
  })
  scene.version++
  return scene
}

/** Counts the calls of the canvas methods that drawScene uses and logs the style of each stroke and fill. */
function mockContext() {
  const log: string[] = []
  const ctx = {
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    dash: [] as number[],
    log,
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    setLineDash: vi.fn((d: number[]) => (ctx.dash = [...d])),
    stroke: vi.fn(() => log.push(`stroke ${ctx.strokeStyle} ${ctx.globalAlpha} [${ctx.dash}]`)),
    fill: vi.fn(() => log.push(`fill ${ctx.fillStyle} ${ctx.globalAlpha}`)),
    rect: vi.fn(),
    arc: vi.fn(),
    fillText: vi.fn(),
  }
  return ctx as typeof ctx & CanvasRenderingContext2D
}
const PALETTE = { edges: ['e0', 'e1', 'e2', 'e3', 'e4'], text: 't', selected: 's', groups: ['0', '1', '2', '3'] }

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
  const scene = () =>
    place(
      buildScene(
        sub([node('a'), node('b', 'Author'), node('c', 'Keyword'), node('far')], [['b', 'far'], ['a', 'b', 'authoredBy'], ['far', 'far']], ['a']),
        true,
        null,
        () => [],
      ),
      [0, 0],
      [50, 0],
      [0, 50],
      [5000, 5000],
    )

  it('sorts edges by type and remembers each type range', () => {
    const s = scene()
    expect([...s.edges]).toEqual([0, 1, 1, 3, 3, 3])
    expect([...s.etype]).toEqual([1, 4, 4])
    expect([...s.typeStart]).toEqual([0, 0, 1, 1, 1, 3])
    expect(s.edgeList.map((e) => e.type)).toEqual(['authoredBy', 'cites', 'cites'])
  })

  it('draws one path per edge type with its colour and dash, arrowheads, nodes per colour, culls and labels when zoomed in', () => {
    const ctx = mockContext()
    drawScene(ctx, scene(), { x: 100, y: 100, k: 1 }, 300, 300, 2, PALETTE)
    expect(ctx.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 200, 200)
    expect(ctx.log).toEqual(['stroke e1 0.5 [6,4]', 'fill e1 0.5', 'stroke e4 0.5 [12,4]', 'fill e4 0.5', 'fill 0 1', 'fill 1 1', 'fill 2 1', 'fill 3 1', 'stroke t 1 []'])
    expect(ctx.lineTo).toHaveBeenCalledTimes(2 + 2)
    expect(ctx.closePath).toHaveBeenCalledTimes(1)
    expect(ctx.arc).toHaveBeenCalledTimes(3 + 1)
    expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c'])
    expect(ctx.fillText).toHaveBeenCalledWith('b', 50, -12)
  })

  it('draws small squares, no dashes, no arrowheads and no labels when zoomed out', () => {
    const ctx = mockContext()
    const s = scene()
    selectNode(s, 1)
    drawScene(ctx, s, { x: 0, y: 0, k: 0.1 }, 300, 300, 1, PALETTE)
    expect(ctx.log.filter((l) => l.includes(' e'))).toEqual(['stroke e1 0.12 []', 'stroke e4 0.12 []', 'stroke e1 1 []', 'fill e1 1', 'stroke e4 1 []', 'fill e4 1'])
    expect(ctx.arc).toHaveBeenCalledTimes(2)
    expect(ctx.rect).toHaveBeenCalledTimes(3)
    expect(ctx.rect).toHaveBeenCalledWith(-10, -10, 20, 20)
    expect(ctx.fillText).not.toHaveBeenCalled()
  })

  it('highlights the edges and neighbours of the selection and dims the rest', () => {
    const s = scene()
    selectNode(s, 1)
    expect(s.incident).toEqual([0, 1])
    expect([...s.near]).toEqual([1, 1, 0, 1])
    const ctx = mockContext()
    drawScene(ctx, s, { x: 100, y: 100, k: 1 }, 300, 300, 1, PALETTE)
    expect(ctx.log).toEqual([
      'stroke e1 0.12 [6,4]',
      'fill e1 0.12',
      'stroke e4 0.12 [12,4]',
      'fill e4 0.12',
      'stroke e1 1 [6,4]',
      'fill e1 1',
      'stroke e4 1 [12,4]',
      'fill e4 1',
      'fill 0 1',
      'fill 0 0.24',
      'fill 1 1',
      'fill 1 0.24',
      'fill 2 1',
      'fill 2 0.24',
      'fill 3 1',
      'fill 3 0.24',
      'stroke t 1 []',
      'stroke s 1 []',
    ])
    selectNode(s, -1)
    expect(s.incident).toEqual([])
    expect([...s.near]).toEqual([0, 0, 0, 0])
  })

  it('leaves out hidden edge types and strengthens the hovered edge', () => {
    const s = scene()
    s.hidden = 1 << EDGE_TYPES.indexOf('cites')
    selectNode(s, 1)
    expect(s.incident).toEqual([0])
    expect([...s.near]).toEqual([1, 1, 0, 0])
    let ctx = mockContext()
    drawScene(ctx, s, { x: 100, y: 100, k: 1 }, 300, 300, 1, PALETTE)
    expect(ctx.log.filter((l) => l.includes('e4'))).toEqual([])
    selectNode(s, -1)
    s.hover = 1
    ctx = mockContext()
    drawScene(ctx, s, { x: 100, y: 100, k: 1 }, 300, 300, 1, PALETTE)
    expect(ctx.log.filter((l) => l.includes(' e'))).toEqual(['stroke e1 0.5 [6,4]', 'fill e1 0.5'])
    s.hidden = 0
    ctx = mockContext()
    drawScene(ctx, s, { x: 100, y: 100, k: 1 }, 300, 300, 1, PALETTE)
    expect(ctx.log.filter((l) => l.includes(' e'))).toEqual(['stroke e1 0.5 [6,4]', 'fill e1 0.5', 'stroke e4 0.5 [12,4]', 'fill e4 0.5', 'stroke e4 1 [12,4]', 'fill e4 1'])
  })

  it('skips the selection ring of an unplaced node', () => {
    const ctx = mockContext()
    const s = buildScene(sub([node('a')]), false, null, () => [])
    selectNode(s, 0)
    drawScene(ctx, s, { x: 0, y: 0, k: 1 }, 100, 100, 1, PALETTE)
    expect(ctx.arc).not.toHaveBeenCalled()
  })
})

describe('edgeAt', () => {
  it('finds the nearest shown edge within 4 screen pixels', () => {
    const s = place(buildScene(sub([node('a'), node('b'), node('c')], [['a', 'b', 'authoredBy'], ['a', 'c']]), false, null, () => []), [0, 0], [100, 0], [0, 100])
    expect(edgeAt(s, 50, 3, 1)).toBe(0)
    expect(edgeAt(s, 3, 50, 1)).toBe(1)
    expect(edgeAt(s, 50, 10, 1)).toBe(-1)
    expect(edgeAt(s, 50, 10, 0.2)).toBe(0)
    expect(edgeAt(s, 150, 0, 1)).toBe(-1)
    s.hidden = 1 << EDGE_TYPES.indexOf('authoredBy')
    expect(edgeAt(s, 50, 3, 1)).toBe(-1)
    place(s, [0, 0], [0, 0], [NaN, NaN])
    s.hidden = 0
    expect(edgeAt(s, 1, 1, 1)).toBe(0)
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
  const edges: [string, string, GraphEdgeType][] = []
  for (let i = 0; i < n; i += 10) for (let e = 0; e < 5 * 2; e++) edges.push([`n${i}`, `n${Math.floor(rand() * n)}`, EDGE_TYPES[e % 5]])
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

  it('draws a zoomed-in frame with arrowheads and a highlighted selection', () => {
    const view = { x: 500, y: 400, k: 1 }
    expect(ms(() => selectNode(scene, 0))).toBeLessThan(n / 500)
    expect(scene.incident.length).toBeGreaterThan(0)
    expect(ms(() => drawScene(ctx, scene, view, 1000, 800, 2, PALETTE))).toBeLessThan(n / 100)
    selectNode(scene, -1)
  })

  it('finds the edge at the pointer', () => {
    expect(ms(() => edgeAt(scene, 10, 10, 1), 100)).toBeLessThan(n / 2000)
  })

  it('answers hit tests', () => {
    scene.version++
    const t = ms(() => hitTest(scene, 0, 0, 1), 1)
    expect(t).toBeLessThan(n / 50)
    expect(ms(() => hitTest(scene, 10, 10, 1), 1000)).toBeLessThan(1)
  })
})
