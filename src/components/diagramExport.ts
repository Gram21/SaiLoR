// [impl->req~ui-320~1]
import { imagePdf } from '../model/imagePdf'
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

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Text width in pixels in the font the preview uses; a rough estimate where there is no canvas. */
function measureText(text: string, size: number, bold: boolean): number {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return text.length * size * 0.58
  ctx.font = `${bold ? 'bold ' : ''}${size}px sans-serif`
  return ctx.measureText(text).width
}

/** The diagram as a one-page PDF: vector graphics and text when the built-in fonts cover the text, else a 3x image the browser compresses. */
export async function svgToPdf(svg: string, width: number, height: number): Promise<Uint8Array> {
  const vector = svgToVectorPdf(svg, measureText)
  if (vector) return vector
  const canvas = await raster(svg, width, height, 3)
  const rgba = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  const rgb = new Uint8Array((rgba.length / 4) * 3)
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    rgb[o] = rgba[i]
    rgb[o + 1] = rgba[i + 1]
    rgb[o + 2] = rgba[i + 2]
  }
  return imagePdf(await deflate(rgb), canvas.width, canvas.height, Math.round(width * 0.75), Math.round(height * 0.75))
}
