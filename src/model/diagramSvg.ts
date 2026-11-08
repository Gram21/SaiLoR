import { xmlText } from './graph'
import { PALETTES, type DiagramConfig, type DiagramData } from './diagram'

const FONT = 'font-family="sans-serif"'
const INK = '#1f2328'
const GRID = '#dcdfe4'
const MUTED = '#6b7280'

const num = (n: number) => String(Math.round(n * 100) / 100)
const attr = (s: string) => xmlText(s).replace(/"/g, '&quot;')
/** A text width estimate in pixels; the SVG has no font metrics outside a browser. */
const textWidth = (s: string, size: number) => s.length * size * 0.58
const clip = (s: string, max: number, size: number) => {
  const chars = Math.max(3, Math.floor(max / (size * 0.58)))
  return s.length > chars ? `${s.slice(0, chars - 1)}…` : s
}

function text(x: number, y: number, s: string, size: number, extra = '') {
  const fill = /\sfill="/.test(` ${extra}`) ? '' : ` fill="${INK}"`
  return `<text x="${num(x)}" y="${num(y)}" font-size="${size}" ${FONT}${fill} ${extra}>${xmlText(s)}</text>`
}

/** A tick step of 1, 2 or 5 times a power of ten, so the axis has at most about `count` ticks. */
export function niceStep(max: number, count: number): number {
  const raw = Math.max(max, 1) / count
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / pow
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow
}

const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
  const p = (a: number) => `${num(cx + r * Math.cos(a))} ${num(cy + r * Math.sin(a))}`
  return `M${num(cx)} ${num(cy)}L${p(a0)}A${num(r)} ${num(r)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}Z`
}

/** The colour of series `i`: the user's choice, else the palette colour; the palette wraps. */
export function seriesColor(config: Pick<DiagramConfig, 'palette' | 'colors'>, name: string, i: number): string {
  const palette = PALETTES[config.palette] ?? PALETTES.okabe
  return config.colors[name] || palette[i % palette.length]
}

// [impl->req~ui-300~1]
/** The diagram as a standalone SVG string. Pure text, so it runs in a worker. */
export function renderDiagram(data: DiagramData, config: DiagramConfig): string {
  const { width: W, height: H, type } = config
  const { cats, series, counts } = data
  const grouped = series.length > 1 || series[0] !== ''
  const name = (i: number) => series[i] || config.yLabel || 'Papers'
  const color = (i: number) => seriesColor(config, series[i], i)
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${attr(config.title || 'Diagram')}">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
  ]
  const top = config.title ? 50 : 20
  if (config.title) out.push(text(W / 2, 32, config.title, 18, 'font-weight="bold" text-anchor="middle"'))
  if (cats.length === 0) {
    out.push(text(W / 2, H / 2, '–', 16, 'text-anchor="middle"'), '</svg>')
    return out.join('\n') + '\n'
  }

  const legendItems = type === 'pie' ? cats.map((c, i) => ({ label: c, color: seriesColor(config, c, i) })) : grouped ? series.map((s, i) => ({ label: s, color: color(i) })) : []
  const showLegend = config.legend && legendItems.length > 0
  const legendW = showLegend ? Math.min(220, Math.max(...legendItems.map((l) => textWidth(l.label, 12))) + 36) : 0
  const right = W - 20 - legendW
  if (showLegend) {
    legendItems.slice(0, Math.floor((H - top - 20) / 20)).forEach((l, i) => {
      const y = top + i * 20
      out.push(`<rect x="${right + 12}" y="${y}" width="12" height="12" rx="2" fill="${attr(l.color)}"/>`)
      out.push(text(right + 30, y + 10, clip(l.label, legendW - 34, 12), 12))
    })
  }

  if (type === 'pie') {
    const totals = counts.map((r) => r.reduce((a, b) => a + b, 0))
    const sum = totals.reduce((a, b) => a + b, 0) || 1
    const cx = (20 + right) / 2
    const cy = (top + H - 20) / 2
    const r = Math.max(10, Math.min(right - 20, H - top - 20) / 2 - 24)
    let a = -Math.PI / 2
    totals.forEach((v, i) => {
      if (v === 0) return
      const next = a + (v / sum) * 2 * Math.PI
      const d = v === sum ? `M${num(cx - r)} ${num(cy)}a${num(r)} ${num(r)} 0 1 0 ${num(2 * r)} 0a${num(r)} ${num(r)} 0 1 0 ${num(-2 * r)} 0Z` : arc(cx, cy, r, a, next)
      out.push(`<path d="${d}" fill="${attr(seriesColor(config, cats[i], i))}" stroke="#ffffff" stroke-width="1.5"><title>${xmlText(`${cats[i]}: ${v}`)}</title></path>`)
      if (config.values && v / sum >= 0.04) {
        const mid = (a + next) / 2
        out.push(text(cx + r * 0.65 * Math.cos(mid), cy + r * 0.65 * Math.sin(mid) + 4, String(v), 12, 'text-anchor="middle" fill="#ffffff" paint-order="stroke" stroke="#00000066" stroke-width="2"'))
      }
      a = next
    })
    out.push('</svg>')
    return out.join('\n') + '\n'
  }

  const rotate = cats.some((c) => textWidth(c, 11) > (right - 70) / cats.length - 4)
  const longest = rotate ? Math.min(140, Math.max(...cats.map((c) => textWidth(c, 11)))) : 0
  const bottom = H - 20 - (config.xLabel ? 22 : 0) - (rotate ? longest * 0.7 + 8 : 18)
  const left = 28 + (config.yLabel ? 22 : 0) + (type === 'heatmap' ? Math.min(160, Math.max(...series.map((s, j) => textWidth(s || name(j), 11)))) : 28)
  const plotW = Math.max(40, right - left - 10)
  const plotH = Math.max(40, bottom - top)
  const band = plotW / cats.length

  const catLabels = () =>
    cats.forEach((c, i) => {
      const x = left + band * (i + 0.5)
      out.push(
        rotate
          ? text(x, bottom + 14, clip(c, 140, 11), 11, `text-anchor="end" transform="rotate(-40 ${num(x)} ${num(bottom + 14)})"`)
          : text(x, bottom + 16, clip(c, band - 4, 11), 11, 'text-anchor="middle"'),
      )
    })
  const axisTitles = () => {
    if (config.xLabel) out.push(text((left + right) / 2, H - 10, config.xLabel, 13, 'text-anchor="middle"'))
    if (config.yLabel) out.push(text(18, (top + bottom) / 2, config.yLabel, 13, `text-anchor="middle" transform="rotate(-90 18 ${num((top + bottom) / 2)})"`))
  }

  if (type === 'heatmap') {
    const rowH = plotH / series.length
    const max = Math.max(1, ...counts.flat())
    const base = color(0)
    series.forEach((s, j) => out.push(text(left - 6, top + rowH * (j + 0.5) + 4, clip(s || name(j), left - (config.yLabel ? 50 : 28), 11), 11, 'text-anchor="end"')))
    cats.forEach((c, i) =>
      series.forEach((s, j) => {
        const v = counts[i][j]
        const x = left + band * i
        const y = top + rowH * j
        out.push(`<rect x="${num(x + 1)}" y="${num(y + 1)}" width="${num(band - 2)}" height="${num(rowH - 2)}" fill="${attr(v ? base : '#f6f7f9')}" fill-opacity="${v ? num(0.12 + (0.88 * v) / max) : 1}"><title>${xmlText(`${c}${s ? ` / ${s}` : ''}: ${v}`)}</title></rect>`)
        if (config.values && v) out.push(text(x + band / 2, y + rowH / 2 + 4, String(v), 11, `text-anchor="middle" ${v / max > 0.55 ? 'fill="#ffffff"' : ''}`))
      }),
    )
    catLabels()
    axisTitles()
    out.push('</svg>')
    return out.join('\n') + '\n'
  }

  const stacked = type === 'stacked'
  const pct = stacked && config.percent
  const vals = counts.map((r) => {
    const total = r.reduce((a, b) => a + b, 0) || 1
    return pct ? r.map((v) => (v / total) * 100) : r
  })
  const label = (i: number, j: number) => (pct ? `${Math.round(vals[i][j])}%` : String(counts[i][j]))
  const tip = (i: number, j: number) => `${cats[i]}${grouped ? ` / ${series[j]}` : ''}: ${counts[i][j]}${pct ? ` (${Math.round(vals[i][j])}%)` : ''}`
  const rowMax = vals.map((r) => (stacked ? r.reduce((a, b) => a + b, 0) : Math.max(...r)))
  const step = Math.max(1, niceStep(Math.max(...rowMax), 6))
  const yMax = Math.max(step, Math.ceil(Math.max(...rowMax) / step - 1e-9) * step)
  const tick = (v: number) => `${v}${pct ? '%' : ''}`

  if (config.horizontal && (type === 'bar' || stacked)) {
    const labelW = Math.min(160, Math.max(...cats.map((c) => textWidth(c, 11))))
    const hLeft = 20 + (config.xLabel ? 22 : 0) + labelW + 8
    const hBottom = H - 20 - (config.yLabel ? 22 : 0) - 18
    const hW = Math.max(40, right - hLeft - 14)
    const hH = Math.max(40, hBottom - top)
    const hBand = hH / cats.length
    const x = (v: number) => hLeft + (v / yMax) * hW
    for (let v = 0; v <= yMax; v += step) {
      out.push(`<line x1="${num(x(v))}" y1="${top}" x2="${num(x(v))}" y2="${num(hBottom)}" stroke="${GRID}"/>`)
      out.push(text(x(v), hBottom + 16, tick(v), 11, `text-anchor="middle" fill="${MUTED}"`))
    }
    out.push(`<line x1="${hLeft}" y1="${top}" x2="${hLeft}" y2="${num(hBottom)}" stroke="${INK}"/>`)
    const thick = Math.min(hBand * 0.8, 40 * series.length) / (stacked ? 1 : series.length)
    cats.forEach((c, i) => {
      const mid = top + hBand * (i + 0.5)
      out.push(text(hLeft - 6, mid + 4, clip(c, labelW, 11), 11, 'text-anchor="end"'))
      let acc = 0
      series.forEach((_, j) => {
        const v = vals[i][j]
        if (!counts[i][j]) return
        const y0 = stacked ? mid - thick / 2 : mid - (thick * series.length) / 2 + thick * j
        const w = (v / yMax) * hW
        const x0 = stacked ? x(acc) : hLeft
        out.push(`<rect x="${num(x0)}" y="${num(y0)}" width="${num(w)}" height="${num(Math.max(1, thick))}" fill="${attr(color(j))}"><title>${xmlText(tip(i, j))}</title></rect>`)
        if (config.values) {
          if (!stacked) out.push(text(x0 + w + 4, y0 + thick / 2 + 4, label(i, j), 11))
          else if (w >= 26) out.push(text(x0 + w / 2, y0 + thick / 2 + 4, label(i, j), 11, 'text-anchor="middle" fill="#ffffff" paint-order="stroke" stroke="#00000066" stroke-width="2"'))
        }
        acc += v
      })
    })
    if (config.xLabel) out.push(text(18, (top + hBottom) / 2, config.xLabel, 13, `text-anchor="middle" transform="rotate(-90 18 ${num((top + hBottom) / 2)})"`))
    if (config.yLabel) out.push(text((hLeft + right) / 2, H - 10, config.yLabel, 13, 'text-anchor="middle"'))
    out.push('</svg>')
    return out.join('\n') + '\n'
  }

  const y = (v: number) => bottom - (v / yMax) * plotH
  for (let v = 0; v <= yMax; v += step) {
    out.push(`<line x1="${left}" y1="${num(y(v))}" x2="${num(left + plotW)}" y2="${num(y(v))}" stroke="${GRID}"/>`)
    out.push(text(left - 6, y(v) + 4, tick(v), 11, `text-anchor="end" fill="${MUTED}"`))
  }
  out.push(`<line x1="${left}" y1="${num(bottom)}" x2="${num(left + plotW)}" y2="${num(bottom)}" stroke="${INK}"/>`)

  if (type === 'line') {
    series.forEach((_, j) => {
      const pts = cats.map((_, i) => `${num(left + band * (i + 0.5))},${num(y(counts[i][j]))}`)
      out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${attr(color(j))}" stroke-width="2.5" stroke-linejoin="round"/>`)
      cats.forEach((_, i) => {
        const cx = left + band * (i + 0.5)
        out.push(`<circle cx="${num(cx)}" cy="${num(y(counts[i][j]))}" r="4" fill="${attr(color(j))}"><title>${xmlText(tip(i, j))}</title></circle>`)
        if (config.values) out.push(text(cx, y(counts[i][j]) - 8, String(counts[i][j]), 11, 'text-anchor="middle"'))
      })
    })
  } else {
    const inner = Math.min(band * 0.8, 60 * series.length) / (stacked ? 1 : series.length)
    const barW = Math.max(1, inner)
    cats.forEach((_, i) => {
      let acc = 0
      series.forEach((_, j) => {
        const v = vals[i][j]
        if (!counts[i][j]) return
        const x = stacked ? left + band * (i + 0.5) - barW / 2 : left + band * (i + 0.5) - (barW * series.length) / 2 + barW * j
        const y0 = stacked ? y(acc + v) : y(v)
        const h = (v / yMax) * plotH
        out.push(`<rect x="${num(x)}" y="${num(y0)}" width="${num(barW)}" height="${num(h)}" fill="${attr(color(j))}"><title>${xmlText(tip(i, j))}</title></rect>`)
        if (config.values && (!stacked || h >= 14)) out.push(text(x + barW / 2, stacked ? y0 + h / 2 + 4 : y0 - 5, label(i, j), 11, `text-anchor="middle"${stacked ? ' fill="#ffffff" paint-order="stroke" stroke="#00000066" stroke-width="2"' : ''}`))
        acc += v
      })
    })
  }
  catLabels()
  axisTitles()
  out.push('</svg>')
  return out.join('\n') + '\n'
}
