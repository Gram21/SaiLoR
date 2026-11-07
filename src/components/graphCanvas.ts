// [impl->req~ui-210~1]
// [impl->req~ui-220~1]
import { quadtree, type Quadtree } from 'd3-quadtree'
import type { GraphEdge, GraphEdgeType, GraphNodeType } from '../model/graph'
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
  /** Node index pairs, sorted by edge type: type t holds the pairs from `typeStart[t]` to `typeStart[t + 1]`. */
  edges: Uint32Array
  edgeList: GraphEdge[]
  etype: Uint8Array
  typeStart: Uint32Array
  group: Uint8Array
  match: Uint8Array
  selected: number
  /** Selected node and its neighbours over shown edge types. */
  near: Uint8Array
  /** Shown edges of the selected node. */
  incident: number[]
  /** Bit t hides edge type `EDGE_TYPES[t]`. */
  hidden: number
  hover: number
  visible: Uint32Array
  version: number
  tree?: { version: number; tree: Quadtree<number> }
}

export interface Palette {
  edges: string[]
  text: string
  selected: string
  groups: string[]
}

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 4
export const LABEL_ZOOM = 0.6
export const LABEL_MAX = 2000
export const ARROW_ZOOM = 0.8
export const DASH_ZOOM = 0.3
export const EDGE_TYPES: GraphEdgeType[] = ['hasAnswer', 'authoredBy', 'publishedIn', 'hasKeyword', 'cites']
/** Dash pattern per edge type in screen pixels, so colour is not the only difference. */
export const EDGE_DASH = [[], [6, 4], [2, 3], [8, 3, 2, 3], [12, 4]]
const EDGE_INDEX = Object.fromEntries(EDGE_TYPES.map((t, i) => [t, i])) as Record<GraphEdgeType, number>
const DIM = 0.12
const HEAD = 6
export const RADIUS = [9, 6, 6, 6]
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
  const edgeList = [...sub.edges].sort((a, b) => EDGE_INDEX[a.type] - EDGE_INDEX[b.type])
  const typeStart = new Uint32Array(EDGE_TYPES.length + 1)
  const etype = new Uint8Array(edgeList.length)
  const edges = new Uint32Array(edgeList.length * 2)
  edgeList.forEach((e, k) => {
    edges[2 * k] = indexOf.get(e.source)!
    edges[2 * k + 1] = indexOf.get(e.target)!
    etype[k] = EDGE_INDEX[e.type]
    typeStart[etype[k] + 1] = k + 1
  })
  for (let t = 1; t < typeStart.length; t++) typeStart[t] = Math.max(typeStart[t], typeStart[t - 1])
  return {
    ids: sub.nodes.map((node) => node.id),
    indexOf,
    labels: sub.nodes.map((node) => short(node.label)),
    xs,
    ys,
    edges,
    edgeList,
    etype,
    typeStart,
    group,
    match,
    selected: -1,
    near: new Uint8Array(n),
    incident: [],
    hidden: 0,
    hover: -1,
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
const DASH = EDGE_DASH.map((d) => d.slice())
const NO_DASH: number[] = []

/** Adds edge e to the current path if its bounding box meets the box; with `head`, adds an arrowhead at a visible target instead. */
export function addEdge(ctx: Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'closePath'>, scene: Scene, e: number, head: boolean, minX: number, minY: number, maxX: number, maxY: number) {
  const { xs, ys, edges } = scene
  const a = edges[2 * e]
  const b = edges[2 * e + 1]
  const ax = xs[a]
  const ay = ys[a]
  const bx = xs[b]
  const by = ys[b]
  if (!head) {
    if (!(Math.max(ax, bx) >= minX && Math.min(ax, bx) <= maxX && Math.max(ay, by) >= minY && Math.min(ay, by) <= maxY)) return
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    return
  }
  if (!(bx >= minX && bx <= maxX && by >= minY && by <= maxY)) return
  const len = Math.hypot(bx - ax, by - ay)
  const r = RADIUS[scene.group[b]]
  if (!(len > r + HEAD)) return
  const ux = (bx - ax) / len
  const uy = (by - ay) / len
  const tx = bx - ux * r
  const ty = by - uy * r
  ctx.moveTo(tx, ty)
  ctx.lineTo(tx - ux * HEAD - uy * HEAD * 0.5, ty - uy * HEAD + ux * HEAD * 0.5)
  ctx.lineTo(tx - ux * HEAD + uy * HEAD * 0.5, ty - uy * HEAD - ux * HEAD * 0.5)
  ctx.closePath()
}

function setDash(ctx: CanvasRenderingContext2D, t: number, k: number) {
  if (k < DASH_ZOOM) return ctx.setLineDash(NO_DASH)
  const base = EDGE_DASH[t]
  const dash = DASH[t]
  for (let i = 0; i < base.length; i++) dash[i] = base[i] / k
  ctx.setLineDash(dash)
}

/**
 * Draws one frame: visible edges in one path per type (own colour and dash, arrowheads when zoomed in),
 * then nodes in one path per colour, small nodes as squares. With a selection, its edges and neighbours are
 * drawn strong and the rest dimmed.
 */
export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene, view: View, w: number, h: number, dpr: number, palette: Palette) {
  const { xs, ys, group, match, visible } = scene
  const { k } = view
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.x, dpr * view.y)
  const minX = -view.x / k
  const minY = -view.y / k
  const maxX = (w - view.x) / k
  const maxY = (h - view.y) / k

  const { typeStart, etype, incident, hidden, near } = scene
  const sel = scene.selected
  const heads = k >= ARROW_ZOOM
  ctx.lineWidth = 1 / k
  ctx.globalAlpha = sel >= 0 ? DIM : 0.5
  for (let t = 0; t < EDGE_TYPES.length; t++) {
    if (hidden & (1 << t) || typeStart[t] === typeStart[t + 1]) continue
    ctx.strokeStyle = ctx.fillStyle = palette.edges[t]
    setDash(ctx, t, k)
    ctx.beginPath()
    for (let e = typeStart[t]; e < typeStart[t + 1]; e++) addEdge(ctx, scene, e, false, minX, minY, maxX, maxY)
    ctx.stroke()
    if (!heads) continue
    ctx.beginPath()
    for (let e = typeStart[t]; e < typeStart[t + 1]; e++) addEdge(ctx, scene, e, true, minX, minY, maxX, maxY)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  const hover = scene.hover >= 0 && !(hidden & (1 << etype[scene.hover])) ? scene.hover : -1
  if (incident.length > 0 || hover >= 0) {
    for (let t = 0; t < EDGE_TYPES.length; t++) {
      if (hidden & (1 << t)) continue
      let any = false
      for (let j = 0; j < incident.length && !any; j++) any = etype[incident[j]] === t
      if (!any && (hover < 0 || etype[hover] !== t)) continue
      ctx.strokeStyle = ctx.fillStyle = palette.edges[t]
      setDash(ctx, t, k)
      for (let head = 0; head < 2; head++) {
        ctx.beginPath()
        for (let j = 0; j < incident.length; j++) if (etype[incident[j]] === t) addEdge(ctx, scene, incident[j], head === 1, minX, minY, maxX, maxY)
        if (etype[hover] === t) addEdge(ctx, scene, hover, head === 1, minX, minY, maxX, maxY)
        ctx.lineWidth = 2.5 / k
        if (head) ctx.fill()
        else ctx.stroke()
      }
    }
  }
  ctx.setLineDash(NO_DASH)

  const count = cull(scene, view, w, h)
  const passes = sel >= 0 ? 2 : 1
  for (let g = 0; g < RADIUS.length; g++) {
    const r = RADIUS[g]
    const square = r * k < 2
    const s = Math.max(r, 1 / k)
    for (let p = 0; p < passes; p++) {
      ctx.beginPath()
      for (let v = 0; v < count; v++) {
        const i = visible[v]
        if (group[i] !== g || (sel >= 0 && near[i] === p)) continue
        if (square) {
          ctx.rect(xs[i] - s, ys[i] - s, 2 * s, 2 * s)
        } else {
          ctx.moveTo(xs[i] + r, ys[i])
          ctx.arc(xs[i], ys[i], r, 0, TAU)
        }
      }
      ctx.globalAlpha = p === 0 ? 1 : DIM * 2
      ctx.fillStyle = palette.groups[g]
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1

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

/** Selects node i (-1 for none) and marks its shown edges and neighbours for drawScene. */
export function selectNode(scene: Scene, i: number) {
  const { edges, etype, near } = scene
  scene.selected = i
  scene.incident = []
  near.fill(0)
  if (i < 0) return
  near[i] = 1
  for (let e = 0; e < etype.length; e++) {
    if (scene.hidden & (1 << etype[e]) || (edges[2 * e] !== i && edges[2 * e + 1] !== i)) continue
    scene.incident.push(e)
    near[edges[2 * e]] = near[edges[2 * e + 1]] = 1
  }
}

/** Index of the nearest shown edge within 4 screen pixels of a world point, or -1. */
export function edgeAt(scene: Scene, wx: number, wy: number, k: number): number {
  const { xs, ys, edges, etype } = scene
  const tol = 4 / k
  let best = -1
  let bestD = tol * tol
  for (let e = 0; e < etype.length; e++) {
    if (scene.hidden & (1 << etype[e])) continue
    const ax = xs[edges[2 * e]]
    const ay = ys[edges[2 * e]]
    const bx = xs[edges[2 * e + 1]]
    const by = ys[edges[2 * e + 1]]
    if (!(wx >= Math.min(ax, bx) - tol && wx <= Math.max(ax, bx) + tol && wy >= Math.min(ay, by) - tol && wy <= Math.max(ay, by) + tol)) continue
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((wx - ax) * dx + (wy - ay) * dy) / len2)) : 0
    const d = (ax + u * dx - wx) ** 2 + (ay + u * dy - wy) ** 2
    if (d <= bestD) {
      best = e
      bestD = d
    }
  }
  return best
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
