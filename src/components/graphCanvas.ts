// [impl->req~ui-210~1]
import { quadtree, type Quadtree } from 'd3-quadtree'
import type { GraphNodeType } from '../model/graph'
import type { SubGraph } from '../model/graphQuery'

export interface View {
  x: number
  y: number
  k: number
}

/** Typed-array form of a sub-graph, so drawing a frame allocates nothing. Positions are NaN until the layout places a node. */
export interface Scene {
  ids: string[]
  indexOf: Map<string, number>
  labels: string[]
  xs: Float32Array
  ys: Float32Array
  edges: Uint32Array
  group: Uint8Array
  match: Uint8Array
  selected: number
  visible: Uint32Array
  version: number
  tree?: { version: number; tree: Quadtree<number> }
}

export interface Palette {
  edge: string
  text: string
  selected: string
  groups: string[]
}

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 4
export const LABEL_ZOOM = 0.6
export const LABEL_MAX = 2000
const RADIUS = [9, 6, 6, 6]
const GROUP: Record<GraphNodeType, number> = { Paper: 0, Author: 1, Venue: 2, Keyword: 2, Choice: 3, Answer: 3 }

const short = (s: string) => (s.length > 28 ? `${s.slice(0, 27)}…` : s)

/** Keeps the positions of nodes that stay and puts a new node next to a placed neighbour. */
export function buildScene(sub: SubGraph, marked: boolean, prev: Scene | null, neighbours: (id: string) => string[]): Scene {
  const n = sub.nodes.length
  const indexOf = new Map<string, number>()
  const xs = new Float32Array(n).fill(NaN)
  const ys = new Float32Array(n).fill(NaN)
  const group = new Uint8Array(n)
  const match = new Uint8Array(n)
  const at = (id: string) => {
    const j = prev?.indexOf.get(id)
    return j === undefined || Number.isNaN(prev!.xs[j]) ? -1 : j
  }
  sub.nodes.forEach((node, i) => {
    indexOf.set(node.id, i)
    group[i] = GROUP[node.type]
    match[i] = marked && sub.seeds.has(node.id) ? 1 : 0
    let j = at(node.id)
    let offset = 0
    if (j < 0) {
      for (const id of neighbours(node.id)) if ((j = at(id)) >= 0) break
      offset = 10
    }
    if (j >= 0) {
      xs[i] = prev!.xs[j] + offset
      ys[i] = prev!.ys[j] + offset
    }
  })
  const edges = new Uint32Array(sub.edges.length * 2)
  sub.edges.forEach((e, k) => {
    edges[2 * k] = indexOf.get(e.source)!
    edges[2 * k + 1] = indexOf.get(e.target)!
  })
  return {
    ids: sub.nodes.map((node) => node.id),
    indexOf,
    labels: sub.nodes.map((node) => short(node.label)),
    xs,
    ys,
    edges,
    group,
    match,
    selected: -1,
    visible: new Uint32Array(n),
    version: 0,
  }
}

/** Writes the indices of the nodes inside the viewport (plus `pad` world units) to `scene.visible`, returns their count. */
export function cull(scene: Scene, view: View, w: number, h: number, pad = 20): number {
  const minX = -view.x / view.k - pad
  const minY = -view.y / view.k - pad
  const maxX = (w - view.x) / view.k + pad
  const maxY = (h - view.y) / view.k + pad
  const { xs, ys, visible } = scene
  let count = 0
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]
    const y = ys[i]
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) visible[count++] = i
  }
  return count
}

export const showLabels = (k: number, count: number) => k >= LABEL_ZOOM && count <= LABEL_MAX

const TAU = Math.PI * 2

/** Draws one frame: all visible edges in one path, nodes in one path per colour, small nodes as squares. */
export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene, view: View, w: number, h: number, dpr: number, palette: Palette) {
  const { xs, ys, edges, group, match, visible } = scene
  const { k } = view
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.x, dpr * view.y)
  const minX = -view.x / k
  const minY = -view.y / k
  const maxX = (w - view.x) / k
  const maxY = (h - view.y) / k

  ctx.beginPath()
  for (let e = 0; e < edges.length; e += 2) {
    const ax = xs[edges[e]]
    const ay = ys[edges[e]]
    const bx = xs[edges[e + 1]]
    const by = ys[edges[e + 1]]
    if (!(Math.max(ax, bx) >= minX && Math.min(ax, bx) <= maxX && Math.max(ay, by) >= minY && Math.min(ay, by) <= maxY)) continue
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
  }
  ctx.globalAlpha = 0.5
  ctx.lineWidth = 1 / k
  ctx.strokeStyle = palette.edge
  ctx.stroke()
  ctx.globalAlpha = 1

  const count = cull(scene, view, w, h)
  for (let g = 0; g < RADIUS.length; g++) {
    const r = RADIUS[g]
    const square = r * k < 2
    const s = Math.max(r, 1 / k)
    ctx.beginPath()
    for (let v = 0; v < count; v++) {
      const i = visible[v]
      if (group[i] !== g) continue
      if (square) {
        ctx.rect(xs[i] - s, ys[i] - s, 2 * s, 2 * s)
      } else {
        ctx.moveTo(xs[i] + r, ys[i])
        ctx.arc(xs[i], ys[i], r, 0, TAU)
      }
    }
    ctx.fillStyle = palette.groups[g]
    ctx.fill()
  }

  ctx.beginPath()
  for (let v = 0; v < count; v++) {
    const i = visible[v]
    if (!match[i]) continue
    const r = RADIUS[group[i]]
    ctx.moveTo(xs[i] + r, ys[i])
    ctx.arc(xs[i], ys[i], r, 0, TAU)
  }
  ctx.lineWidth = 2 / k
  ctx.strokeStyle = palette.text
  ctx.stroke()

  const sel = scene.selected
  if (sel >= 0 && !Number.isNaN(xs[sel])) {
    ctx.beginPath()
    ctx.arc(xs[sel], ys[sel], RADIUS[group[sel]] + 1, 0, TAU)
    ctx.lineWidth = 3 / k
    ctx.strokeStyle = palette.selected
    ctx.stroke()
  }

  if (!showLabels(k, count)) return
  ctx.fillStyle = palette.text
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'center'
  for (let v = 0; v < count; v++) {
    const i = visible[v]
    ctx.fillText(scene.labels[i], xs[i], ys[i] - 12)
  }
}

/** Index of the node nearest to a world point within its radius (at least 4 screen pixels), or -1. The quadtree is rebuilt only after positions changed. */
export function hitTest(scene: Scene, wx: number, wy: number, k: number): number {
  if (scene.tree?.version !== scene.version) {
    const t = quadtree<number>()
      .x((i) => scene.xs[i])
      .y((i) => scene.ys[i])
    t.addAll(Array.from(scene.ids.keys()))
    scene.tree = { version: scene.version, tree: t }
  }
  return scene.tree.tree.find(wx, wy, Math.max(RADIUS[0], 4 / k)) ?? -1
}

/** Zooms by `factor` around the screen point (px, py). */
export function zoomAt(view: View, px: number, py: number, factor: number) {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor))
  view.x = px - ((px - view.x) * k) / view.k
  view.y = py - ((py - view.y) * k) / view.k
  view.k = k
}

/** Fits all placed nodes into a w×h viewport, never zooming in past 1. Without placed nodes, centres the origin. */
export function fitView(view: View, scene: Scene | null, w: number, h: number) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const xs = scene?.xs ?? []
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]
    const y = scene!.ys[i]
    if (Number.isNaN(x)) continue
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  if (minX > maxX) {
    minX = maxX = minY = maxY = 0
  }
  const pad = 40
  const fit = Math.min(w / (maxX - minX + 2 * pad), h / (maxY - minY + 2 * pad))
  view.k = w > 0 && h > 0 ? Math.max(MIN_ZOOM, Math.min(1, fit)) : 1
  view.x = w / 2 - ((minX + maxX) / 2) * view.k
  view.y = h / 2 - ((minY + maxY) / 2) * view.k
}
