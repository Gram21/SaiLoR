/**
 * Renders build/icon.svg to build/icon.png (1024x1024, transparent).
 *
 * electron-builder needs a raster icon; the SVG is the source of truth. Rather
 * than pull in a rasterizer (or hand-export and let the two drift apart), this
 * borrows the Chromium that Electron already brings.
 *
 *   npm run icon
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const SIZE = 1024
const svgPath = path.join(__dirname, '..', 'build', 'icon.svg')
const pngPath = path.join(__dirname, '..', 'build', 'icon.png')

// Disable the compositor's background so the captured page keeps its alpha.
app.commandLine.appendSwitch('force-color-profile', 'srgb')

app.whenReady().then(async () => {
  const svg = readFileSync(svgPath, 'utf-8')
  const html = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;background:transparent}
    svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${svg}`

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  })

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  // Offscreen rendering paints a frame after load; give it one.
  await new Promise((r) => setTimeout(r, 400))

  let image = await win.webContents.capturePage()
  // On a HiDPI display the capture comes back at the device scale factor.
  if (image.getSize().width !== SIZE) image = image.resize({ width: SIZE, height: SIZE })

  writeFileSync(pngPath, image.toPNG())
  console.log(`wrote ${path.relative(process.cwd(), pngPath)} (${image.getSize().width}px)`)
  app.exit(0)
})
