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

// Main window + unsaved-changes coordination for a clean quit.
let mainWindow: BrowserWindow | null = null
let isDirty = false
let allowClose = false
let isQuitting = false

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
  mainWindow = win

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // Intercept close (window button, Cmd+Q, quit menu) when there are unsaved
  // changes, and ask the user via a native dialog instead of silently blocking.
  win.on('close', (e) => {
    if (allowClose || !isDirty) return
    e.preventDefault()
    void promptUnsavedChanges(win)
  })

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL)
  } else {
    void win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

async function promptUnsavedChanges(win: BrowserWindow) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'Do you want to save the changes to your project?',
    detail: "Your changes will be lost if you don't save them.",
  })
  if (response === 2) {
    // Cancel — stay open. Reset the quit intent so a later plain window
    // close doesn't inadvertently quit the whole app.
    isQuitting = false
    return
  }
  if (response === 1) {
    // Don't Save — close, discarding changes.
    allowClose = true
    finishClose(win)
    return
  }
  // Save — ask the renderer to save, then close once it reports back.
  win.webContents.send('app:requestSave')
}

/** Complete a close that was deferred for the unsaved-changes prompt. */
function finishClose(win: BrowserWindow) {
  if (isQuitting) app.quit() // resume the quit; close now passes (allowClose)
  else win.destroy()
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
    {
      // Custom Edit menu: Undo/Redo drive the app's annotation history (routed
      // to the renderer via IPC) rather than native text undo, so undo works
      // consistently across the whole app. Cut/copy/paste/selectAll stay native.
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => mainWindow?.webContents.send('app:undo'),
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => mainWindow?.webContents.send('app:redo'),
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
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

ipcMain.on('app:setDirty', (_e, dirty: boolean) => {
  isDirty = Boolean(dirty)
})

ipcMain.on('app:saveComplete', (_e, ok: boolean) => {
  // The renderer finished the save it was asked to perform before quitting.
  if (ok && mainWindow) {
    allowClose = true
    finishClose(mainWindow)
  } else {
    // Save failed or was cancelled — abort the quit and keep the window open.
    isQuitting = false
  }
})

app.whenReady().then(() => {
  registerPdfProtocol()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Remember that a quit is in progress so the close guard can, after the user
// confirms, resume quitting (rather than merely closing the window on macOS).
app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
