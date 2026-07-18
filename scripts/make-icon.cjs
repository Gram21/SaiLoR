/**
 * Renders public/logo.svg to build/icon.png (1024x1024, transparent), then —
 * on macOS — builds build/icon.icns from it via the OS's own `sips`/`iconutil`.
 *
 * electron-builder needs a raster icon; the SVG is the source of truth. Rather
 * than pull in a rasterizer (or hand-export and let the two drift apart), this
 * borrows the Chromium that Electron already brings.
 *
 * The source SVG lives under `public/`, not `build/`, because it is also the
 * in-app logo shown on the welcome screen (`src/App.tsx`) — one artwork file
 * feeds both the packaged app's icon and the running app's own UI, rather than
 * two copies that could drift apart.
 *
 * The .icns step exists because handing electron-builder the bare PNG and
 * letting *it* auto-convert produced a visibly worse macOS icon (small sizes
 * looked muddy/undersized in the Dock and Finder) than Apple's own `iconutil`
 * does from the same source pixels — `mac.icon` in package.json points at the
 * .icns this produces, not the .png. iconutil is macOS-only, so on other
 * platforms this step is skipped with a note: regenerate the .icns on a Mac
 * (or in CI's macOS runner) whenever logo.svg changes.
 *
 *   npm run icon
 */
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const SIZE = 1024
const svgPath = path.join(__dirname, '..', 'public', 'logo.svg')
const pngPath = path.join(__dirname, '..', 'build', 'icon.png')
const icnsPath = path.join(__dirname, '..', 'build', 'icon.icns')

// Disable the compositor's background so the captured page keeps its alpha.
app.commandLine.appendSwitch('force-color-profile', 'srgb')

/** The full set iconutil requires in a .iconset directory. */
const ICNS_SIZES = [16, 32, 128, 256, 512]

function buildIcns() {
  const iconset = mkdtempSync(path.join(os.tmpdir(), 'sailor-icon-')) + '.iconset'
  execFileSync('mkdir', ['-p', iconset])
  try {
    for (const size of ICNS_SIZES) {
      execFileSync('sips', ['-z', String(size), String(size), pngPath, '--out', path.join(iconset, `icon_${size}x${size}.png`)])
      const size2x = size * 2
      execFileSync('sips', ['-z', String(size2x), String(size2x), pngPath, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)])
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icnsPath])
    console.log(`wrote ${path.relative(process.cwd(), icnsPath)}`)
  } finally {
    rmSync(iconset, { recursive: true, force: true })
  }
}

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

  if (process.platform === 'darwin') {
    buildIcns()
  } else {
    console.log('Skipping icon.icns (needs macOS\'s iconutil) — regenerate it on a Mac.')
  }
  app.exit(0)
})
