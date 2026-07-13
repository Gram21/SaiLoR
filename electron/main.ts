import { app, BrowserWindow, dialog, ipcMain, protocol, net, Menu } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Where Vite emits the renderer build, and the dev server URL (set by the plugin in dev).
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(__dirname, '../dist')

// The base directory of the currently-open project; PDFs resolve against it.
let projectDir: string | null = null

// slr-file:// must be registered as privileged before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'slr-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL)
  } else {
    void win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

function registerPdfProtocol() {
  // Serve files from the open project's directory, guarding against traversal.
  protocol.handle('slr-file', async (request) => {
    if (!projectDir) return new Response('No project open', { status: 404 })
    const url = new URL(request.url)
    // URL: slr-file://project/<encoded relative path>
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const resolved = path.resolve(projectDir, rel)
    const base = path.resolve(projectDir)
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      return await net.fetch(pathToFileURL(resolved).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function buildMenu() {
  // A minimal menu that keeps the standard Edit shortcuts (copy/paste/cut/undo).
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' as const } : { role: 'quit' as const }],
    },
    { role: 'editMenu' },
    {
      // Custom View menu: deliberately omit the zoom roles so their Ctrl +/-/0
      // accelerators reach the renderer, which uses them for app font scaling
      // (native page zoom would also scale the PDF "paper", which we don't want).
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- IPC: file dialogs + fs ----

ipcMain.handle('project:open', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Open SLR project',
    filters: [{ name: 'SLR project', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const filePath = res.filePaths[0]
  const text = await readFile(filePath, 'utf-8')
  return { path: filePath, text }
})

ipcMain.handle('project:openPath', async (_e, filePath: string) => {
  try {
    const text = await readFile(filePath, 'utf-8')
    return { path: filePath, text }
  } catch {
    return null // file moved/deleted/unreadable
  }
})

ipcMain.handle('project:save', async (_e, filePath: string, text: string) => {
  await writeFile(filePath, text, 'utf-8')
})

ipcMain.handle('project:saveAs', async (_e, text: string, suggestedName: string) => {
  const res = await dialog.showSaveDialog({
    title: 'Save SLR project as',
    defaultPath: suggestedName,
    filters: [{ name: 'SLR project', extensions: ['json'] }],
  })
  if (res.canceled || !res.filePath) return null
  await writeFile(res.filePath, text, 'utf-8')
  return { path: res.filePath }
})

ipcMain.handle('project:setDir', (_e, filePath: string) => {
  projectDir = path.dirname(filePath)
})

app.whenReady().then(() => {
  registerPdfProtocol()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
