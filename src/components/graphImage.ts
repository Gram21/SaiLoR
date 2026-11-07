// [impl->req~ui-260~1]
import { xmlText } from '../model/graph'
import {
  addEdge,
  ARROW_ZOOM,
  cull,
  DASH_ZOOM,
  drawScene,
  EDGE_DASH,
  EDGE_TYPES,
  RADIUS,
  showLabels,
  type Palette,
  type Scene,
  type View,
} from './graphCanvas'

export type ImageArea = 'visible' | 'all'
export type ImageFormat = 'svg' | 'png'

/** A view and the size of the image it fills, in CSS pixels. */
export interface Frame {
  view: View
  w: number
  h: number
}

/** The longest side of an image of the whole graph, in pixels. */
export const MAX_SIDE = 8192
const PAD = 40
const MAX_PIXELS = 64_000_000

/** The frame of the visible area, or a frame that fits every placed node, scaled down to at most `MAX_SIDE`. */
export function imageFrame(scene: Scene, view: View, w: number, h: number, area: ImageArea): Frame {
  if (area === 'visible') return { view: { ...view }, w, h }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < scene.xs.length; i++) {
    const x = scene.xs[i]
    const y = scene.ys[i]
    if (Number.isNaN(x)) continue
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  if (minX > maxX) minX = maxX = minY = maxY = 0
  const bw = maxX - minX + 2 * PAD
  const bh = maxY - minY + 2 * PAD
  const k = Math.min(1, MAX_SIDE / Math.max(bw, bh))
  return { view: { x: (PAD - minX) * k, y: (PAD - minY) * k, k }, w: Math.max(1, Math.ceil(bw * k)), h: Math.max(1, Math.ceil(bh * k)) }
}

/** Draws without the hover and selection highlight, so the image shows the graph and not the pointer. */
const plain = (scene: Scene): Scene => ({ ...scene, hover: -1, selected: -1, incident: [] })

const num = (n: number) => String(Math.round(n * 100) / 100)
const attr = (s: string) => xmlText(s).replace(/"/g, '&quot;')

/** Collects the path segments `addEdge` draws, as SVG path data. */
function pathRecorder() {
  let d = ''
  return {
    moveTo: (x: number, y: number) => void (d += `M${num(x)} ${num(y)}`),
    lineTo: (x: number, y: number) => void (d += `L${num(x)} ${num(y)}`),
    closePath: () => void (d += 'Z'),
    get d() {
      return d
    },
  }
}

/** The graph in `frame` as SVG: the shown edge types, the nodes, the query marks and, when zoomed in enough, the labels. */
export function sceneToSvg(source: Scene, frame: Frame, palette: Palette, background: string): string {
  const scene = plain(source)
  const { view, w, h } = frame
  const { k } = view
  const minX = -view.x / k
  const minY = -view.y / k
  const maxX = (w - view.x) / k
  const maxY = (h - view.y) / k
  const { xs, ys, group, match, visible, typeStart, hidden } = scene
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="${attr(background)}"/>`,
    `<g transform="translate(${num(view.x)} ${num(view.y)}) scale(${k})">`,
  ]
  for (let t = 0; t < EDGE_TYPES.length; t++) {
    if (hidden & (1 << t) || typeStart[t] === typeStart[t + 1]) continue
    const color = attr(palette.edges[t])
    const dash = k >= DASH_ZOOM && EDGE_DASH[t].length > 0 ? ` stroke-dasharray="${EDGE_DASH[t].map((d) => num(d / k)).join(' ')}"` : ''
    const lines = pathRecorder()
    for (let e = typeStart[t]; e < typeStart[t + 1]; e++) addEdge(lines, scene, e, false, minX, minY, maxX, maxY)
    if (lines.d) out.push(`<path d="${lines.d}" fill="none" stroke="${color}" stroke-opacity="0.5" stroke-width="${num(1 / k)}"${dash}/>`)
    if (k < ARROW_ZOOM) continue
    const heads = pathRecorder()
    for (let e = typeStart[t]; e < typeStart[t + 1]; e++) addEdge(heads, scene, e, true, minX, minY, maxX, maxY)
    if (heads.d) out.push(`<path d="${heads.d}" fill="${color}" fill-opacity="0.5"/>`)
  }
  const count = cull(scene, view, w, h)
  for (let g = 0; g < RADIUS.length; g++) {
    const r = RADIUS[g]
    const square = r * k < 2
    const s = Math.max(r, 1 / k)
    let d = ''
    for (let v = 0; v < count; v++) {
      const i = visible[v]
      if (group[i] !== g) continue
      d += square
        ? `M${num(xs[i] - s)} ${num(ys[i] - s)}h${num(2 * s)}v${num(2 * s)}h${num(-2 * s)}Z`
        : `M${num(xs[i] + r)} ${num(ys[i])}a${r} ${r} 0 1 0 ${-2 * r} 0a${r} ${r} 0 1 0 ${2 * r} 0`
    }
    if (d) out.push(`<path d="${d}" fill="${attr(palette.groups[g])}"/>`)
  }
  let ring = ''
  for (let v = 0; v < count; v++) {
    const i = visible[v]
    if (!match[i]) continue
    const r = RADIUS[group[i]]
    ring += `M${num(xs[i] + r)} ${num(ys[i])}a${r} ${r} 0 1 0 ${-2 * r} 0a${r} ${r} 0 1 0 ${2 * r} 0`
  }
  if (ring) out.push(`<path d="${ring}" fill="none" stroke="${attr(palette.text)}" stroke-width="${num(2 / k)}"/>`)
  if (showLabels(k, count)) {
    out.push(`<g fill="${attr(palette.text)}" font-family="sans-serif" font-size="10" text-anchor="middle">`)
    for (let v = 0; v < count; v++) {
      const i = visible[v]
      out.push(`<text x="${num(xs[i])}" y="${num(ys[i] - 12)}">${xmlText(scene.labels[i])}</text>`)
    }
    out.push('</g>')
  }
  out.push('</g>', '</svg>')
  return out.join('\n') + '\n'
}

/** The graph in `frame` as PNG bytes. A visible-area image uses the screen's pixel ratio, capped to `MAX_PIXELS`. */
export async function sceneToPng(source: Scene, frame: Frame, palette: Palette, background: string, ratio: number): Promise<Uint8Array> {
  const { view, w, h } = frame
  const dpr = Math.max(1, Math.min(ratio, Math.sqrt(MAX_PIXELS / (w * h))))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas')
  drawScene(ctx, plain(source), view, w, h, dpr, palette)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('No image')
  return new Uint8Array(await blob.arrayBuffer())
}
