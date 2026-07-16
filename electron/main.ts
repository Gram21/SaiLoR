import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  net,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  shell,
} from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile, writeFile, access, readdir } from 'node:fs/promises'
import { constants, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
// The only imports of src/ into electron/: the git URL/path security gate and
// the porcelain/error-text parsers must not exist twice — see "Git" below for
// why. Both modules import nothing themselves, so they typecheck identically
// under this file's tsconfig (node types) and the renderer's (DOM types).
import { validateGitUrl, validateClonePath } from '../src/git/url'
import { gitErrorText, parsePorcelain } from '../src/git/output'
import type { GitRun } from '../src/git/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Where Vite emits the renderer build, and the dev server URL (set by the plugin in dev).
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(__dirname, '../dist')

// App icon for the taskbar/dock. electron-builder's `build.icon` only sets the
// packaged bundle icon; setting it here also covers `npm run dev:electron` and
// the macOS dock (which needs app.dock.setIcon at runtime). build/icon.png is
// included in the packaged app via the electron-builder `files` list.
const appIcon = nativeImage.createFromPath(path.join(__dirname, '../build/icon.png'))

// The base directory of the currently-open project; PDFs resolve against it.
let projectDir: string | null = null

// Main window + unsaved-changes coordination for a clean quit.
let mainWindow: BrowserWindow | null = null
let isDirty = false
let allowClose = false
let isQuitting = false

// slr-file:// must be registered as privileged before the app is ready.
//
// `corsEnabled` is load-bearing: the renderer's origin (the dev server, or file://
// in the packaged app) is not slr-file://, so fetching a PDF is a cross-origin
// request. Without this, Chromium rejects it *before* protocol.handle runs — the
// handler never sees the request and pdf.js reports "Unexpected server response (0)".
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'slr-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
])

// ---- Settings migration from the pre-rename app ----

// The app used to be called "SLR Helper". Electron derives userData from the app
// name, so the rename alone would strand the user's window size (window-state.json)
// and their recent-projects list (localStorage, i.e. Chromium's Local Storage
// store) in a directory nothing reads any more. Copy them across once. Both old
// spellings are tried, because the name Electron used differed between the
// packaged app (productName) and `npm run dev:electron` (package.json name).
const LEGACY_APP_DIRS = ['SLR Helper', 'slr-helper']

/**
 * Copy the previous app's settings into this one, but only into a profile that
 * has never been used — an existing profile always wins over an old one.
 * Best-effort: a failure here just means starting fresh, so it must not be fatal.
 */
function migrateLegacyUserData(): void {
  const userData = app.getPath('userData')
  const used = existsSync(path.join(userData, 'window-state.json')) ||
    existsSync(path.join(userData, 'Local Storage'))
  if (used) return

  const appData = app.getPath('appData')
  const legacy = LEGACY_APP_DIRS.map((dir) => path.join(appData, dir)).find(
    (dir) =>
      dir !== userData &&
      (existsSync(path.join(dir, 'window-state.json')) ||
        existsSync(path.join(dir, 'Local Storage'))),
  )
  if (!legacy) return

  try {
    mkdirSync(userData, { recursive: true })
    for (const item of ['window-state.json', 'Local Storage']) {
      const from = path.join(legacy, item)
      if (existsSync(from)) cpSync(from, path.join(userData, item), { recursive: true })
    }
    console.log(`Migrated settings from "${legacy}".`)
  } catch (err) {
    console.warn('Could not migrate settings from the previous app name:', err)
  }
}

// Must run before Chromium opens the profile, so: before app.whenReady().
migrateLegacyUserData()

// ---- Window state persistence (size/position across restarts) ----

const DEFAULT_WIDTH = 1920
const DEFAULT_HEIGHT = 1080

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized?: boolean
}

const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json')

/** Read the persisted window state, falling back to the default size. */
function loadWindowState(): WindowState {
  try {
    const s = JSON.parse(readFileSync(windowStateFile(), 'utf-8')) as Partial<WindowState>
    if (typeof s.width === 'number' && typeof s.height === 'number') {
      return {
        width: s.width,
        height: s.height,
        x: typeof s.x === 'number' ? s.x : undefined,
        y: typeof s.y === 'number' ? s.y : undefined,
        isMaximized: Boolean(s.isMaximized),
      }
    }
  } catch {
    // No saved state (first run) or unreadable file — use defaults.
  }
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
}

/** Only reuse a saved position if it still overlaps a connected display, so a
 *  disconnected monitor can't strand the window off-screen. */
function positionIsOnScreen(state: WindowState): boolean {
  if (state.x === undefined || state.y === undefined) return false
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    return (
      state.x! < wa.x + wa.width &&
      state.x! + state.width > wa.x &&
      state.y! < wa.y + wa.height &&
      state.y! + state.height > wa.y
    )
  })
}

/** Persist the window's current size/position (using the pre-maximize "normal"
 *  bounds so restore returns to the size the user actually chose). */
function saveWindowState(win: BrowserWindow) {
  if (win.isDestroyed()) return
  const maximized = win.isMaximized() || win.isFullScreen()
  const bounds = maximized ? win.getNormalBounds() : win.getBounds()
  const state: WindowState = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized: maximized,
  }
  try {
    writeFileSync(windowStateFile(), JSON.stringify(state))
  } catch {
    // Non-critical (e.g. read-only userData) — ignore.
  }
}

// ---- External links ----

/** Open a URL in the user's default browser. Restricted to safe web schemes —
 *  handing arbitrary schemes (file:, etc.) to the OS could launch programs. */
function openExternalUrl(url: string) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
    void shell.openExternal(url)
  }
}

/** The app's own document: the dev server URL in dev, the bundled file:// in prod. */
function isAppUrl(url: string): boolean {
  return DEV_SERVER_URL ? url.startsWith(DEV_SERVER_URL) : url.startsWith('file://')
}

function createWindow() {
  const state = loadWindowState()
  const useSavedPosition = positionIsOnScreen(state)
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(useSavedPosition ? { x: state.x, y: state.y } : {}),
    // Window/taskbar icon (Windows/Linux; ignored on macOS, which uses the dock).
    ...(appIcon.isEmpty() ? {} : { icon: appIcon }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  if (state.isMaximized) win.maximize()
  mainWindow = win

  // External links in the PDF are rendered with target="_blank". Don't open an
  // Electron window for them — hand them to the user's default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })

  // Safety net: never let a link navigate the app window away from the app.
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return
    e.preventDefault()
    openExternalUrl(url)
  })

  // Persist size/position when the user changes it. Resize/move are debounced to
  // avoid a write per pixel; close saves the final state synchronously.
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveWindowState(win), 400)
  }
  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('maximize', scheduleSave)
  win.on('unmaximize', scheduleSave)
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveWindowState(win)
  })

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

ipcMain.handle('project:setDir', (_e, filePath: string) => {
  projectDir = path.dirname(filePath)
})

// Only picks a location — the project editor writes through project:save later,
// so an empty file never appears if the user abandons the editor.
ipcMain.handle('project:pickSavePath', async (_e, suggestedName: string) => {
  const res = await dialog.showSaveDialog({
    title: 'Choose where to store the project JSON',
    defaultPath: suggestedName,
    filters: [{ name: 'SLR project', extensions: ['json'] }],
  })
  if (res.canceled || !res.filePath) return null
  return { path: res.filePath }
})

ipcMain.handle('pdf:pick', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Add PDFs',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  })
  if (res.canceled) return []
  return res.filePaths
})

/** Every `.pdf` under `dir`, recursively. A directory that can't be read (permissions,
 *  a symlink loop) is skipped rather than failing the whole walk. */
async function collectPdfsRecursive(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string) {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && /\.pdf$/i.test(entry.name)) out.push(full)
    }
  }
  await walk(dir)
  return out
}

ipcMain.handle('pdf:pickFolder', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Add a folder of PDFs',
    properties: ['openDirectory'],
  })
  if (res.canceled || res.filePaths.length === 0) return []
  return collectPdfsRecursive(res.filePaths[0])
})

ipcMain.handle('reference:pick', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Import references',
    filters: [{ name: 'Reference files', extensions: ['bib', 'ris', 'json'] }],
    properties: ['openFile'],
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const filePath = res.filePaths[0]
  const text = await readFile(filePath, 'utf-8')
  return { text, name: path.basename(filePath) }
})

/**
 * Peek at each recent project: does the file still exist, and what title does it
 * currently carry? The title is re-read rather than trusted from the stored
 * recents entry, which goes stale as soon as the file is edited elsewhere (e.g.
 * renamed in the project editor).
 *
 * Parsing is cheap enough for the five recents, and each file is handled
 * independently so one broken JSON can't take the others down.
 */
ipcMain.handle('project:peek', async (_e, paths: string[]) => {
  return Promise.all(
    paths.map(async (p) => {
      try {
        await access(p, constants.R_OK)
      } catch {
        return { exists: false }
      }
      try {
        const raw = JSON.parse(await readFile(p, 'utf-8')) as { title?: unknown }
        const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title : undefined
        return { exists: true, title }
      } catch {
        // The file is there but unreadable/not JSON — still openable-ish, and
        // the caller keeps whatever title it already had.
        return { exists: true }
      }
    }),
  )
})

// Raw bytes of a PDF, so the editor can read its title/authors. Unlike the
// slr-file:// protocol this is not confined to the project directory — the user
// may pick PDFs from anywhere, and they chose the file via a native dialog.
ipcMain.handle('pdf:read', async (_e, filePath: string) => {
  const buf = await readFile(filePath)
  // Return a plain Uint8Array; Buffer doesn't survive the IPC boundary intact.
  return new Uint8Array(buf)
})

// PDF references are stored relative to the project JSON so the project stays
// portable. Forward slashes keep the JSON identical across platforms.
ipcMain.handle('paths:relative', (_e, fromFile: string, toFiles: string[]) => {
  const fromDir = path.dirname(fromFile)
  return toFiles.map((to) => path.relative(fromDir, to).split(path.sep).join('/'))
})

// "Save as" moves the project file, so paths relative to the old file have to be
// re-expressed relative to the new one — otherwise every PDF stops resolving.
ipcMain.handle('paths:rebase', (_e, fromFile: string, toFile: string, rels: string[]) => {
  const fromDir = path.dirname(fromFile)
  const toDir = path.dirname(toFile)
  return rels.map((rel) => {
    const abs = path.resolve(fromDir, rel)
    return path.relative(toDir, abs).split(path.sep).join('/')
  })
})

// The inverse of paths:relative — a paper imported from a screening project
// carries a `pdf` relative to *that* file, so the editor needs a real absolute
// source to re-derive it if the new JSON moves (see `absolutePdfPaths`).
ipcMain.handle('paths:absolute', (_e, fromFile: string, rels: string[]) => {
  const fromDir = path.dirname(fromFile)
  return rels.map((rel) => path.resolve(fromDir, rel))
})

// Where a new project JSON would live if it sat next to `sourceFile` — the
// default location for "New from screening…" (see `siblingProjectLocation`).
ipcMain.handle('paths:sibling', (_e, sourceFile: string, fileName: string) => {
  return path.join(path.dirname(sourceFile), fileName)
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
  // macOS shows the dock icon from the running app; set it explicitly so it
  // appears in development too (not just in the packaged .app bundle).
  if (process.platform === 'darwin' && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon)
  }
  registerPdfProtocol()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// ---- AI-assisted annotation: LLM targets and the outbound call ----
//
// Two jobs live here, and both are here for the same reason: **the API key must
// never enter the renderer.**
//
// 1. Storage. Targets live in userData/llm-config.json with the key encrypted via
//    safeStorage (the OS keychain). The renderer is told only whether a key
//    exists, never what it is.
// 2. Transport. The renderer builds the whole request, but can only put the
//    literal sentinel where the key goes; we substitute the real key here and
//    send with net.fetch. That also sidesteps CORS: a renderer fetch to an LLM
//    API is a preflighted cross-origin POST from a `file://` origin and would be
//    blocked (the same wall the slr-file:// protocol hit — see `corsEnabled` above).

const API_KEY_SENTINEL = '{{apiKey}}'

interface StoredLlmConfig {
  id: string
  name: string
  provider: string
  baseUrl: string
  model: string
  attach: string
  reasoningEffort?: string
  /** safeStorage-encrypted key, base64. Absent when the user has not set one. */
  key?: string
}

const llmConfigFile = () => path.join(app.getPath('userData'), 'llm-config.json')

function readLlmConfigs(): StoredLlmConfig[] {
  try {
    const raw = JSON.parse(readFileSync(llmConfigFile(), 'utf-8')) as unknown
    return Array.isArray(raw) ? (raw as StoredLlmConfig[]) : []
  } catch {
    // No file yet, or it is unreadable — start from an empty list rather than fail.
    return []
  }
}

function writeLlmConfigs(configs: StoredLlmConfig[]): void {
  writeFileSync(llmConfigFile(), JSON.stringify(configs, null, 2), { mode: 0o600 })
}

/** The renderer's view: everything except the key. */
function publicConfigs(configs: StoredLlmConfig[]) {
  return configs.map(({ key, ...rest }) => ({ ...rest, hasKey: Boolean(key) }))
}

function encryptKey(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // Refuse rather than silently write the key in the clear. On Linux this can
    // happen when no keyring is available; the user is told, and can still use
    // the app without AI.
    throw new Error('This system provides no secure storage, so the API key cannot be saved.')
  }
  return safeStorage.encryptString(plain).toString('base64')
}

function decryptKey(encrypted: string): string {
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}

ipcMain.handle('llm:configs', () => publicConfigs(readLlmConfigs()))

ipcMain.handle('llm:saveConfig', (_e, config: StoredLlmConfig, apiKey?: string) => {
  const configs = readLlmConfigs()
  const existing = configs.find((c) => c.id === config.id)
  // An edit that leaves the key field blank keeps the stored key: the user cannot
  // read it back to retype it.
  const key = apiKey ? encryptKey(apiKey) : existing?.key
  const next: StoredLlmConfig = { ...config, ...(key ? { key } : {}) }
  const merged = existing
    ? configs.map((c) => (c.id === config.id ? next : c))
    : [...configs, next]
  writeLlmConfigs(merged)
  return publicConfigs(merged)
})

ipcMain.handle('llm:deleteConfig', (_e, id: string) => {
  const merged = readLlmConfigs().filter((c) => c.id !== id)
  writeLlmConfigs(merged)
  return publicConfigs(merged)
})

// In-flight calls, so the renderer's Cancel button can abort one.
const inFlight = new Map<string, AbortController>()

ipcMain.on('llm:abort', (_e, requestId: string) => {
  inFlight.get(requestId)?.abort()
})

ipcMain.handle(
  'llm:call',
  async (
    _e,
    requestId: string,
    request: {
      configId: string
      url: string
      headers: Record<string, string>
      method?: 'GET' | 'POST'
      body?: string
    },
  ) => {
    const config = readLlmConfigs().find((c) => c.id === request.configId)
    if (!config) throw new Error('That LLM target no longer exists.')
    if (!config.key) throw new Error('No API key is stored for this target.')

    // The renderer names the URL, so check it before handing over the key: a
    // compromised renderer must not be able to post the key to a host of its
    // choosing. It has to be the origin the user configured.
    const target = new URL(request.url)
    const allowed = new URL(config.baseUrl)
    if (target.origin !== allowed.origin) {
      throw new Error(`Refusing to send the API key to ${target.origin}.`)
    }

    const apiKey = decryptKey(config.key)
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [k, v.split(API_KEY_SENTINEL).join(apiKey)]),
    )

    const controller = new AbortController()
    inFlight.set(requestId, controller)
    try {
      const res = await net.fetch(request.url, {
        method: request.method ?? 'POST',
        headers,
        body: request.method === 'GET' ? undefined : request.body,
        signal: controller.signal,
      })
      return { ok: res.ok, status: res.status, body: await res.text() }
    } finally {
      inFlight.delete(requestId)
    }
  },
)

// ---- Git: run the user's own git binary ----
//
// The whole feature lives here rather than in a library because the user asked
// for "the local git installation": their git, their ~/.gitconfig, their
// credential helper, their SSH agent. A bundled reimplementation would be none
// of those — see openwiki/architecture.md's "Git" section for the full reasoning
// (this is Electron-only; the browser build has no local git to reach at all).
//
// Two rules hold for every call below and are not negotiable:
//
//  * execFile with an argument array, never a shell string, and `--` before any
//    user-supplied path or URL. A repository URL is user input reaching a
//    spawned process; without both, a URL of "--upload-pack=…" would be read as
//    an option rather than an argument.
//  * The renderer never names an argv. It picks one of the operations below and
//    supplies data; this file decides what git is actually asked to do. Handing
//    the renderer a general `git <args>` channel would be handing it arbitrary
//    code execution (git has `--exec-path`, aliases, and the `ext::` transport).

/** Plumbing: rev-parse, status, diff, add, commit. */
const GIT_TIMEOUT_MS = 30_000
/** Network: clone, fetch, push. A repository of PDFs is genuinely slow. */
const GIT_NETWORK_TIMEOUT_MS = 900_000
/** A diff of a large project JSON blows execFile's 1 MB default. */
const GIT_MAX_BUFFER = 32 * 1024 * 1024

/**
 * The child's environment.
 *
 * `GIT_TERMINAL_PROMPT=0` and `GIT_EDITOR=true` are **not** weakening
 * anything: this process has no terminal, so a git that decides to ask for a
 * username or open an editor would block forever on a tty that does not
 * exist, and the app would look frozen with no way out. Both make git fail
 * immediately with its own message instead. Credential helpers, askpass
 * programs and SSH agents are untouched, because none of them is a terminal
 * prompt — which is exactly the point: the user's configured way of
 * authenticating still works, and only the "type it at the console" path
 * (which cannot work here) is turned off.
 *
 * The GIT_* variables are stripped because SaiLoR may have been launched from
 * a shell sitting inside some other repository, and an inherited GIT_DIR
 * would silently point every command below at it.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG',
    'GIT_CONFIG_GLOBAL',
  ]) {
    delete env[k]
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_EDITOR = 'true'
  env.GIT_SEQUENCE_EDITOR = 'true'
  return env
}

/**
 * Run git. A non-zero exit is **data, not an exception**: the exact text git
 * printed is what the user has to see, and half of git's useful output
 * arrives on a failing exit code (a merge that conflicts exits 1, and that is
 * the normal path here). Only a failure to launch git at all is signalled
 * with `code: null`.
 */
function runGit(args: string[], cwd?: string, timeout = GIT_TIMEOUT_MS): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, env: gitEnv(), timeout, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null
        if (!e) {
          resolve({ ok: true, code: 0, stdout, stderr })
          return
        }
        if (e.killed) {
          resolve({
            ok: false,
            code: null,
            stdout,
            stderr: `git timed out after ${Math.round(timeout / 1000)}s.`,
          })
          return
        }
        if (typeof e.code === 'number') {
          resolve({ ok: false, code: e.code, stdout, stderr })
          return
        }
        // ENOENT and friends: git never started.
        resolve({ ok: false, code: null, stdout, stderr: e.message })
      },
    )
  })
}

const gitOut = (r: GitRun) => r.stdout.trim()

/** A repo-relative path from git's own output (`--show-prefix`, or a value the
 *  renderer hands back to us for a git:pull* call); never absolute, never an
 *  escape. Re-checked here because the renderer names the relative path. */
function assertRelPath(p: string): void {
  if (!p || path.isAbsolute(p) || p.split('/').includes('..') || /[\0\r\n]/.test(p)) {
    throw new Error(`Refusing to act on the path "${p}".`)
  }
}

ipcMain.handle('git:probe', async () => {
  const r = await runGit(['--version'])
  return r.ok
    ? { available: true, version: gitOut(r), error: '' }
    : { available: false, version: '', error: r.stderr.trim() || "git was not found on this system's PATH." }
})

ipcMain.handle('git:pickCloneDir', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose where to clone the repository',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
})

ipcMain.handle('git:clone', async (_e, url: string, dest: string) => {
  const badUrl = validateGitUrl(url)
  if (badUrl) return { ok: false, error: badUrl }
  const badDest = validateClonePath(dest)
  if (badDest) return { ok: false, error: badDest }
  const r = await runGit(['clone', '--', url, dest], undefined, GIT_NETWORK_TIMEOUT_MS)
  return r.ok ? { ok: true, dest } : { ok: false, error: gitErrorText(r) }
})

// The mechanism the user asked for: `defaultPath` opens the picker inside the
// freshly cloned repository. Returns only the chosen path — the caller reuses
// the ordinary project-open path (`project:openPath` via `openRecent`), so
// opening a project does not exist twice.
ipcMain.handle('git:pickProjectIn', async (_e, dir: string) => {
  const res = await dialog.showOpenDialog({
    title: 'Open SLR project',
    defaultPath: dir,
    filters: [{ name: 'SLR project', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
})

ipcMain.handle('git:info', async (_e, projectPath: string) => {
  const dir = path.dirname(projectPath)
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], dir)
  if (!inside.ok || gitOut(inside) !== 'true') return null

  // `--show-toplevel` resolves symlinks (on macOS a /tmp path realpaths under
  // /private/tmp), so `path.relative(root, projectPath)` would compute a `..`
  // escape that points nowhere. `--show-prefix` is git's own answer to "where
  // in the work tree is my cwd", which is exactly what's needed here.
  const root = gitOut(await runGit(['rev-parse', '--show-toplevel'], dir))
  const prefix = gitOut(await runGit(['rev-parse', '--show-prefix'], dir))
  const relPath = prefix + path.basename(projectPath)
  const hasHead = (await runGit(['rev-parse', '--verify', '-q', 'HEAD'], dir)).ok
  const branchRun = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], dir)
  const branch = branchRun.ok ? gitOut(branchRun) || null : null // null = detached HEAD
  const upRun = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir)
  const upstream = upRun.ok ? gitOut(upRun) || null : null
  return { root, relPath, branch, upstream, hasHead }
})

ipcMain.handle('git:status', async (_e, root: string) => {
  const porcelain = (await runGit(['status', '--porcelain=v1', '-z'], root)).stdout
  const hasHead = (await runGit(['rev-parse', '--verify', '-q', 'HEAD'], root)).ok
  // --no-color: a user with color.diff=always would otherwise leak ANSI escape
  // sequences into the <pre> as literal text. --no-pager costs one token and
  // removes a whole class of hang.
  const diff = hasHead
    ? (await runGit(['--no-pager', 'diff', '--no-color', 'HEAD', '--'], root)).stdout
    : ''
  return { porcelain, diff }
})

ipcMain.handle('git:commit', async (_e, root: string, paths: string[], message: string) => {
  paths.forEach(assertRelPath)
  if (paths.length === 0) {
    return { ok: false, code: null, stdout: '', stderr: 'Nothing selected to commit.' }
  }
  // `add` then a pathspec-limited commit: `add` handles an untracked or
  // deleted path uniformly, and the pathspec means the user's own separately
  // staged work elsewhere in the repo is neither committed nor disturbed.
  const add = await runGit(['add', '--', ...paths], root)
  if (!add.ok) return add
  // `--` protects the paths but deliberately not `message`: `-m` consumes the
  // next argument whatever it starts with, and rejecting a message beginning
  // with "-" would reject a legitimate one.
  return runGit(['commit', '-m', message, '--', ...paths], root)
})

ipcMain.handle('git:push', async (_e, root: string) => {
  // Plain `git push`; the branch's own remote/merge config decides where. When
  // there is no upstream, git's own message names the exact command to run —
  // surfaced verbatim rather than inventing --set-upstream on the user's behalf.
  return runGit(['push'], root, GIT_NETWORK_TIMEOUT_MS)
})

/**
 * The pull classification. Contract: this always returns with the repository
 * in exactly one of two states — not mid-merge, for every outcome except
 * `'merge'`, or mid-merge with nothing unmerged except `relPath`, for
 * `'merge'`. It never returns leaving a half-merge the renderer did not ask for.
 */
ipcMain.handle('git:pullBegin', async (_e, root: string, relPath: string) => {
  assertRelPath(relPath)

  const st = await runGit(['status', '--porcelain=v1', '-z'], root)
  // Untracked files ('??') never block a merge, so they are not "dirty" here.
  const dirty = parsePorcelain(st.stdout)
    .filter((c) => c.code !== '??')
    .map((c) => c.path)
  if (dirty.length > 0) return { kind: 'dirty', paths: dirty }

  const up = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root)
  if (!up.ok) {
    const branchRun = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], root)
    return { kind: 'no-upstream', branch: branchRun.ok ? gitOut(branchRun) || null : null }
  }
  const ref = gitOut(up)

  const fetch = await runGit(['fetch'], root, GIT_NETWORK_TIMEOUT_MS)
  if (!fetch.ok) return { kind: 'error', message: gitErrorText(fetch) }

  if ((await runGit(['merge-base', '--is-ancestor', '@{u}', 'HEAD'], root)).ok) {
    return { kind: 'up-to-date' }
  }

  if ((await runGit(['merge-base', '--is-ancestor', 'HEAD', '@{u}'], root)).ok) {
    const ff = await runGit(['merge', '--ff-only', '@{u}'], root)
    return ff.ok ? { kind: 'fast-forwarded' } : { kind: 'error', message: gitErrorText(ff) }
  }

  // Divergent. Read the three revisions of the project file BEFORE touching
  // the work tree, so nothing that follows can change what gets merged.
  const baseRun = await runGit(['merge-base', 'HEAD', '@{u}'], root)
  const baseSha = baseRun.ok ? gitOut(baseRun) : null
  const baseShow = baseSha ? await runGit(['show', `${baseSha}:${relPath}`], root) : null
  const base = baseShow?.ok ? baseShow.stdout : null // null is fine — added on both sides.
  const oursShow = await runGit(['show', `HEAD:${relPath}`], root)
  const theirsShow = await runGit(['show', `${ref}:${relPath}`], root)
  if (!oursShow.ok || !theirsShow.ok) {
    return {
      kind: 'error',
      message: `The project file does not exist at ${!oursShow.ok ? 'HEAD' : ref}. Merge this by hand with git.`,
    }
  }

  const merge = await runGit(['merge', '--no-commit', '--no-ff', ref], root)
  // A merge that fails to *start* (unrelated histories, a hook refusing) leaves
  // no MERGE_HEAD; `merge --abort` would then itself fail with "There is no
  // merge to abort". Checking MERGE_HEAD is what keeps the contract above true.
  if (!(await runGit(['rev-parse', '--verify', '-q', 'MERGE_HEAD'], root)).ok) {
    return { kind: 'error', message: gitErrorText(merge) }
  }

  const st2 = await runGit(['status', '--porcelain=v1', '-z'], root)
  const unmerged = parsePorcelain(st2.stdout)
    .filter((c) => c.unmerged)
    .map((c) => c.path)
  const others = unmerged.filter((p) => p !== relPath)
  if (others.length > 0) {
    // SaiLoR knows how to merge an annotation JSON. It does not know how to
    // merge a PDF or a .gitignore — abort cleanly and hand it back rather
    // than half-doing it.
    await runGit(['merge', '--abort'], root)
    return { kind: 'conflict-elsewhere', paths: others }
  }

  return { kind: 'merge', ref, base, ours: oursShow.stdout, theirs: theirsShow.stdout }
})

ipcMain.handle('git:pullFinish', async (_e, root: string, relPath: string, text: string) => {
  assertRelPath(relPath)
  await writeFile(path.join(root, relPath), text, 'utf-8')
  const add = await runGit(['add', '--', relPath], root)
  if (!add.ok) return add
  // `git commit` after a merge with MERGE_HEAD set records both parents and
  // allows an empty tree change, which is why the merge commit is made this
  // way rather than with `commit-tree` or `merge -m`. `--no-edit` takes git's
  // own prepared MERGE_MSG; GIT_EDITOR=true above is the backstop.
  return runGit(['commit', '--no-edit'], root)
})

ipcMain.handle('git:pullAbort', async (_e, root: string) => {
  return runGit(['merge', '--abort'], root)
})

// Remember that a quit is in progress so the close guard can, after the user
// confirms, resume quitting (rather than merely closing the window on macOS).
app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
