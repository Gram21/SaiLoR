import { latin1, pdfDocument, type PdfObject } from './imagePdf'
import type { TrueTypeFont } from './ttf'

// [impl->req~ui-370~1]
/** Characters of the two built-in PDF fonts (WinAnsi); other scripts need an embedded font. */
const WIN_ANSI: Record<string, number> = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f }
const winAnsi = (ch: string): number | undefined => {
  const c = ch.charCodeAt(0)
  return c >= 0x20 && c <= 0x7e ? c : c >= 0xa0 && c <= 0xff ? c : WIN_ANSI[ch]
}

/** The characters of the SVG's texts that the built-in fonts lack. */
export function nonWinAnsiChars(svg: string): string[] {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  const found = new Set<string>()
  for (const el of root.querySelectorAll('text')) for (const ch of el.textContent ?? '') if (winAnsi(ch) === undefined) found.add(ch)
  return [...found]
}

/** A TrueType font to embed: `file` is the font file, deflated; `length` its size before deflating. */
export interface PdfFont {
  ttf: TrueTypeFont
  file: Uint8Array
  length: number
}

const hex4 = (v: number) => v.toString(16).padStart(4, '0')
const utf16 = (cp: number) => (cp > 0xffff ? hex4(0xd800 + ((cp - 0x10000) >> 10)) + hex4(0xdc00 + ((cp - 0x10000) & 0x3ff)) : hex4(cp))

/** A ToUnicode CMap, so that viewers can copy and search the text set in the embedded font. */
function toUnicodeCMap(map: Map<number, number>): string {
  const lines = [...map].map(([g, cp]) => `<${hex4(g)}> <${utf16(cp)}>`)
  const blocks: string[] = []
  for (let i = 0; i < lines.length; i += 100) blocks.push(`${Math.min(100, lines.length - i)} beginbfchar\n${lines.slice(i, i + 100).join('\n')}\nendbfchar`)
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${blocks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`
}

const n = (v: number) => String(Math.round(v * 1000) / 1000)
const num = (el: Element, name: string, fallback = 0) => {
  const v = parseFloat(el.getAttribute(name) ?? '')
  return Number.isFinite(v) ? v : fallback
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` as PDF colour components and alpha; null for `none` or an unknown value. */
function colour(value: string | null): { rgb: string; alpha: number } | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value ?? '')
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  const part = (i: number) => n(parseInt(h.slice(i, i + 2), 16) / 255)
  return { rgb: `${part(0)} ${part(2)} ${part(4)}`, alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 }
}

/** A circular arc as line segments, from (x0,y0) to (x1,y1) with SVG arc flags; the radius grows if the ends are too far apart. */
function arcPoints(x0: number, y0: number, r: number, large: number, sweep: number, x1: number, y1: number): [number, number][] {
  const dx = (x1 - x0) / 2
  const dy = (y1 - y0) / 2
  const half = Math.hypot(dx, dy)
  if (half === 0) return []
  const radius = Math.max(r, half)
  const h = Math.sqrt(Math.max(0, radius * radius - half * half))
  const sign = large === sweep ? -1 : 1
  const cx = x0 + dx - (sign * h * dy) / half
  const cy = y0 + dy + (sign * h * dx) / half
  const a0 = Math.atan2(y0 - cy, x0 - cx)
  let da = Math.atan2(y1 - cy, x1 - cx) - a0
  if (sweep && da < 0) da += 2 * Math.PI
  if (!sweep && da > 0) da -= 2 * Math.PI
  const steps = Math.max(2, Math.ceil(Math.abs(da) / (Math.PI / 32)))
  return Array.from({ length: steps }, (_, i) => [cx + radius * Math.cos(a0 + (da * (i + 1)) / steps), cy + radius * Math.sin(a0 + (da * (i + 1)) / steps)])
}

/** PDF path operators for the M, L, A, Z commands (absolute or relative) that the diagrams use. */
function pathOps(d: string): string {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  const ops: string[] = []
  let x = 0
  let y = 0
  let cmd = ''
  for (let i = 0; i < tokens.length; ) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    const up = cmd.toUpperCase()
    if (up === 'Z') {
      ops.push('h')
      continue
    }
    const take = (k: number) => tokens.slice(i, (i += k)).map(Number)
    if (up === 'M' || up === 'L') {
      const [px, py] = take(2)
      x = rel ? x + px : px
      y = rel ? y + py : py
      ops.push(`${n(x)} ${n(y)} ${up === 'M' ? 'm' : 'l'}`)
    } else if (up === 'A') {
      const [r, , , large, sweep, px, py] = take(7)
      const ex = rel ? x + px : px
      const ey = rel ? y + py : py
      for (const [lx, ly] of arcPoints(x, y, r, large, sweep, ex, ey)) ops.push(`${n(lx)} ${n(ly)} l`)
      x = ex
      y = ey
    } else break
  }
  return ops.join(' ')
}

/**
 * A one-page vector PDF of an SVG diagram: rectangles, lines, circles, paths, polylines and text, with the two built-in
 * Helvetica fonts. A text with a character those fonts lack is set in `font`, which is embedded; without `font` that
 * character becomes `?`. `replaced` counts the characters drawn as `?` or as the font's missing-glyph box. `glyphs` lists the glyph ids of `font` that the PDF uses. Throws if
 * `svg` is not an SVG document. `measure` gives the width of a text in pixels, for the centred and right-aligned labels.
 */
export function svgToVectorPdf(
  svg: string,
  measure: (text: string, size: number, bold: boolean) => number,
  font?: PdfFont,
): { pdf: Uint8Array; replaced: number; glyphs: number[] } {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  if (root.localName !== 'svg' || root.querySelector('parsererror')) throw new Error('Not an SVG document')
  let replaced = 0
  const glyphWidths = new Map<number, number>()
  const unicode = new Map<number, number>()
  const W = num(root, 'width')
  const H = num(root, 'height')
  const alphas = new Map<number, string>()
  const state = (a: number) => {
    if (!alphas.has(a)) alphas.set(a, `G${alphas.size}`)
    return `/${alphas.get(a)} gs `
  }
  const out: string[] = [`1 0 0 -1 0 ${n(H)} cm`]
  const paint = (el: Element) => {
    const fillAttr = el.getAttribute('fill')
    const fill = colour(fillAttr ?? '#000000')
    const stroke = colour(el.getAttribute('stroke'))
    const opacity = num(el, 'fill-opacity', 1)
    let ops = ''
    if (fill) ops += `${state(fill.alpha * opacity)}${fill.rgb} rg `
    if (stroke) ops += `${state(stroke.alpha)}${stroke.rgb} RG ${n(num(el, 'stroke-width', 1))} w `
    return { ops, op: fill && stroke ? 'B' : fill ? 'f' : stroke ? 'S' : 'n' }
  }
  const emit = (el: Element, body: (el: Element) => string) => {
    const { ops, op } = paint(el)
    out.push(`q ${ops}${body(el)} ${op} Q`)
  }
  for (const el of root.querySelectorAll('rect, line, polyline, circle, path, text')) {
    const tag = el.localName
    if (tag === 'rect') {
      emit(el, (e) => `${n(num(e, 'x'))} ${n(num(e, 'y'))} ${n(num(e, 'width'))} ${n(num(e, 'height'))} re`)
    } else if (tag === 'line') {
      out.push(`q ${colour(el.getAttribute('stroke'))?.rgb ?? '0 0 0'} RG ${n(num(el, 'stroke-width', 1))} w ${n(num(el, 'x1'))} ${n(num(el, 'y1'))} m ${n(num(el, 'x2'))} ${n(num(el, 'y2'))} l S Q`)
    } else if (tag === 'polyline') {
      const pts = (el.getAttribute('points') ?? '').split(/[\s,]+/).map(Number)
      const body = pts.reduce<string[]>((acc, v, i) => (i % 2 ? acc : [...acc, `${n(v)} ${n(pts[i + 1])} ${i ? 'l' : 'm'}`]), []).join(' ')
      emit(el, () => `1 j ${body}`)
    } else if (tag === 'circle') {
      const cx = num(el, 'cx')
      const cy = num(el, 'cy')
      const r = num(el, 'r')
      emit(el, () => `${n(cx + r)} ${n(cy)} m ${arcPoints(cx + r, cy, r, 0, 1, cx - r, cy).concat(arcPoints(cx - r, cy, r, 0, 1, cx + r, cy)).map(([px, py]) => `${n(px)} ${n(py)} l`).join(' ')}`)
    } else if (tag === 'path') {
      emit(el, (e) => pathOps(e.getAttribute('d') ?? ''))
    } else {
      const s = el.textContent ?? ''
      const size = num(el, 'font-size', 12)
      const bold = el.getAttribute('font-weight') === 'bold'
      const anchor = el.getAttribute('text-anchor')
      const embedded = font && [...s].some((ch) => winAnsi(ch) === undefined)
      let shown: string
      let w: number
      if (font && embedded) {
        const glyphs = [...s].map((ch) => font.ttf.glyph(ch.codePointAt(0) ?? 0))
        for (const g of glyphs) glyphWidths.set(g, Math.round((font.ttf.advance(g) * 1000) / font.ttf.unitsPerEm))
        ;[...s].forEach((ch, i) => glyphs[i] && !unicode.has(glyphs[i]) && unicode.set(glyphs[i], ch.codePointAt(0) ?? 0))
        replaced += glyphs.filter((g) => !g).length
        shown = `<${glyphs.map((g) => g.toString(16).padStart(4, '0')).join('')}>`
        w = (glyphs.reduce((sum, g) => sum + font.ttf.advance(g), 0) * size) / font.ttf.unitsPerEm
      } else {
        const bytes = [...s].map((ch) => winAnsi(ch) ?? (replaced++, 0x3f))
        shown = `(${String.fromCharCode(...bytes).replace(/[\\()]/g, '\\$&')})`
        w = measure(s, size, bold)
      }
      const x = num(el, 'x') - (anchor === 'middle' ? w / 2 : anchor === 'end' ? w : 0)
      const y = num(el, 'y')
      const rot = /rotate\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(el.getAttribute('transform') ?? '')
      const turn = rot ? ((Number(rot[1]) * Math.PI) / 180) : 0
      const [c, sn, rx, ry] = rot ? [Math.cos(turn), Math.sin(turn), Number(rot[2]), Number(rot[3])] : [1, 0, 0, 0]
      const matrix = rot ? `${n(c)} ${n(sn)} ${n(-sn)} ${n(c)} ${n(rx - c * rx + sn * ry)} ${n(ry - sn * rx - c * ry)} cm ` : ''
      const string = `${shown} Tj`
      const fill = colour(el.getAttribute('fill') ?? '#000000')
      const halo = colour(el.getAttribute('stroke'))
      const face = `/${embedded ? 'F3' : bold ? 'F2' : 'F1'} ${n(size)} Tf 1 0 0 -1 ${n(x)} ${n(y)} Tm`
      const faux = embedded && bold ? `${fill?.rgb ?? '0 0 0'} RG ${n(size * 0.03)} w 2 Tr ` : ''
      const parts = [`q ${matrix}BT`]
      if (halo && el.getAttribute('paint-order') === 'stroke') parts.push(`${state(halo.alpha)}${halo.rgb} RG ${n(num(el, 'stroke-width', 1))} w 1 Tr ${face} ${string} 0 Tr`)
      parts.push(`${state(fill?.alpha ?? 1)}${fill?.rgb ?? '0 0 0'} rg ${faux}${face} ${string} ET Q`)
      out.push(parts.join(' '))
    }
  }
  const gs = [...alphas].map(([a, name]) => `/${name} << /ca ${n(a)} /CA ${n(a)} >>`).join(' ')
  const content = latin1(`0.75 0 0 0.75 0 0 cm\n${out.join('\n')}`)
  const w = n(W * 0.75)
  const h = n(H * 0.75)
  const extra: PdfObject[] = []
  if (font && glyphWidths.size) {
    const scale = 1000 / font.ttf.unitsPerEm
    const [x0, y0, x1, y1] = font.ttf.bbox.map((v) => Math.round(v * scale))
    const widths = [...glyphWidths].map(([g, width]) => `${g} [${width}]`).join(' ')
    extra.push(
      '<< /Type /Font /Subtype /Type0 /BaseFont /EmbeddedFont /Encoding /Identity-H /DescendantFonts [8 0 R] /ToUnicode 11 0 R >>',
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /EmbeddedFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 9 0 R /DW 1000 /W [${widths}] /CIDToGIDMap /Identity >>`,
      `<< /Type /FontDescriptor /FontName /EmbeddedFont /Flags 4 /FontBBox [${x0} ${y0} ${x1} ${y1}] /ItalicAngle 0 /Ascent ${Math.round(font.ttf.ascent * scale)} /Descent ${Math.round(font.ttf.descent * scale)} /CapHeight ${Math.round(font.ttf.ascent * scale)} /StemV 80 /FontFile2 10 0 R >>`,
      { data: font.file, dict: `/Filter /FlateDecode /Length1 ${font.length}` },
      { data: latin1(toUnicodeCMap(unicode)), dict: '' },
    )
  }
  const pdf = pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 5 0 R /F2 6 0 R${extra.length ? ' /F3 7 0 R' : ''} >> /ExtGState << ${gs} >> >> /Contents 4 0 R >>`,
    { data: content, dict: '' },
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    ...extra,
  ])
  return { pdf, replaced, glyphs: [...glyphWidths.keys()] }
}
