// [impl->req~ui-320~1]
import { svgToVectorPdf } from '../model/vectorPdf'

export type DiagramFormat = 'svg' | 'png' | 'pdf'

async function raster(svg: string, width: number, height: number, scale: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No canvas')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The diagram as PNG bytes, at `scale` times its size. */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Uint8Array> {
  const canvas = await raster(svg, width, height, scale)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('No image')
  return new Uint8Array(await blob.arrayBuffer())
}

/** Text width in pixels in the font the preview uses; a rough estimate where there is no canvas. */
function measureText(text: string, size: number, bold: boolean): number {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return text.length * size * 0.58
  ctx.font = `${bold ? 'bold ' : ''}${size}px sans-serif`
  return ctx.measureText(text).width
}

/** The diagram as a one-page vector PDF. `replaced` counts characters the PDF fonts lack, drawn as `?`. */
export function svgToPdf(svg: string): { pdf: Uint8Array; replaced: number } {
  return svgToVectorPdf(svg, measureText)
}
