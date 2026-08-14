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
  session,
  shell,
} from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile, writeFile, access, readdir, lstat, realpath, unlink, mkdir, rm } from 'node:fs/promises'
import { constants, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
// The only imports of src/ into electron/: shared logic that must not exist
// twice — see "Git" below for the git URL/path/output modules. All of these
// import nothing DOM-specific themselves, so they typecheck identically under
// this file's tsconfig (node types) and the renderer's (DOM types).
import { validateGitUrl, validateClonePath } from '../src/git/url'
import { relPathProblem, annotationsRelDir } from '../src/git/relpath'
import { refProblem } from '../src/git/ref'
import { gitErrorText, parsePorcelain, parseGitLog } from '../src/git/output'
import { ownAnnotationPathMatcher } from '../src/git/ownAnnotationPath'
import type { GitRun, MergeStart } from '../src/git/types'
import { isLegacyProjectShape, assembleLegacyProjectJson } from '../src/model/project'
import { parseMarks, type PdfMark } from '../src/model/pdfMarks'
import { rectToPdfPoints, rectToQuadPoints } from '../src/model/pdfExport'
import { PDFDocument, PDFHexString, PDFString, type PDFContext, type PDFDict } from 'pdf-lib'
import { autoUpdater } from 'electron-updater'

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

// A `pdf` value the reviewer explicitly chose to open even though it points
// outside `projectDir` — see `resolveProjectPath`. Keyed by the exact stored
// relative path, not by where it resolves to: the decision is "I trust this
// specific reference in this specific project", not "I trust this file
// forever". Session-only (in memory, never written to disk) and cleared
// whenever `projectDir` actually changes to a different directory — an
// approval for one project's external reference must not silently carry
// over to a different project that happens to store the same relative path.
const allowedEscapes = new Set<string>()

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
  // Both flags describe the *previous* window's close, not this one. On macOS
  // the app outlives its last window (`window-all-closed` only quits off
  // darwin), so a window closed via the unsaved-changes prompt leaves
  // `allowClose = true` behind — and the next window, reopened from the dock,
  // would then sail past the close guard (`if (allowClose || !isDirty) return`)
  // and discard a whole session's unsaved work without ever prompting.
  allowClose = false
  isQuitting = false

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
      sandbox: true,
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

/**
 * Reload, asking first when the renderer has unsaved changes.
 *
 * Only a confirmation, not the three-way Save/Don't Save/Cancel of a close: a
 * reload is a debugging affordance rather than a normal step in a review, and
 * routing it through the renderer's save round-trip (which can itself open a
 * native Save dialog) to then reload underneath that is more machinery than the
 * action warrants. Refusing by default is what matters — the old behaviour
 * discarded the work outright.
 */
async function guardedReload(win: BrowserWindow | undefined, force: boolean) {
  if (!win) return
  if (isDirty) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Reload anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'Reload and discard unsaved changes?',
      detail: "Your changes will be lost if you reload before saving them.",
    })
    if (response === 0) return
  }
  if (force) win.webContents.reloadIgnoringCache()
  else win.webContents.reload()
}

/** Complete a close that was deferred for the unsaved-changes prompt. */
function finishClose(win: BrowserWindow) {
  if (isQuitting) app.quit() // resume the quit; close now passes (allowClose)
  else win.destroy()
}

type ProjectPathCheck =
  | { ok: true; real: string }
  | { ok: false; reason: 'no-project' | 'escapes' | 'not-found' }

/**
 * Resolves `rel` against the open project's directory and checks it stays
 * inside it — the one place this logic lives, shared by the `slr-file://`
 * protocol handler below (which then reads the file) and the `pdf:checkPath`
 * IPC call (which lets the renderer ask *before* handing pdf.js a URL, so a
 * blocked or missing PDF gets an honest reason instead of pdf.js's own
 * opaque load-failure message for an HTTP 403/404 it doesn't explain).
 *
 * `path.resolve` is pure string arithmetic — it collapses `..` but follows no
 * links, so a symlink *inside* the project directory resolves to a path that
 * passes the first check and would then read from wherever it actually
 * points. A project folder is received material and can ship one: a
 * `pdfs/paper.pdf` linked to `/etc/passwd` read as in-bounds. `realpath`
 * resolves the chain, so the second check sees the real destination — but
 * only when `rel` claimed to be in-bounds to begin with. `allowedEscapes`
 * (see its own comment) is the reviewer overriding the boundary check
 * outright for one specific path they were asked about and agreed to; there
 * is no "inside the project" expectation left to protect for it.
 */
async function resolveProjectPath(rel: string): Promise<ProjectPathCheck> {
  if (!projectDir) return { ok: false, reason: 'no-project' }
  const resolved = path.resolve(projectDir, rel)
  const base = path.resolve(projectDir)
  const withinBase = resolved === base || resolved.startsWith(base + path.sep)
  if (!withinBase && !allowedEscapes.has(rel)) {
    return { ok: false, reason: 'escapes' }
  }
  let real: string
  try {
    real = await realpath(resolved)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  if (withinBase) {
    let realBase: string
    try {
      realBase = await realpath(base)
    } catch {
      return { ok: false, reason: 'no-project' }
    }
    if (real !== realBase && !real.startsWith(realBase + path.sep)) {
      return { ok: false, reason: 'escapes' }
    }
  }
  return { ok: true, real }
}

function registerPdfProtocol() {
  // Serve files from the open project's directory, guarding against traversal.
  protocol.handle('slr-file', async (request) => {
    const url = new URL(request.url)
    // URL: slr-file://project/pdf?path=<encoded relative path> — the path is
    // carried in the *query*, not the URL path, because a `..` sitting in
    // the path is a dot-segment by the URL Standard's own definition and
    // gets collapsed during normal URL parsing (Chromium's, constructing the
    // request, same as this file's own `new URL()` would) — silently eating
    // every ".." a `pdf` value climbed with before this handler ever runs.
    // `searchParams.get` already decodes; see `getPdfSource` in
    // src/platform/electron.ts, which is the only thing that builds this URL.
    const rel = url.searchParams.get('path') ?? ''
    const check = await resolveProjectPath(rel)
    if (!check.ok) {
      if (check.reason === 'escapes') return new Response('Forbidden', { status: 403 })
      return new Response(check.reason === 'no-project' ? 'No project open' : 'Not found', { status: 404 })
    }
    try {
      return await net.fetch(pathToFileURL(check.real).toString())
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
        // Not `{ role: 'reload' }`/`{ role: 'forceReload' }`: those carry
        // Cmd/Ctrl+R and reload the renderer immediately. A reload emits
        // neither `close` nor `will-navigate`, so the unsaved-changes guard
        // below never sees it — and the desktop build deliberately installs no
        // `beforeunload` handler either (see `useDirtyGuard`), so a reflexive
        // Ctrl+R threw away every unsaved annotation with no prompt at all.
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: (_item, win) => void guardedReload(win as BrowserWindow | undefined, false),
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: (_item, win) => void guardedReload(win as BrowserWindow | undefined, true),
        },
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

/**
 * Since v1.3, a project's own annotations live outside `project.json` — one
 * `annotations/<paperId>/reviewer-<n>.json` (and `consolidated.json`) per
 * paper, next to it — so that two reviewers editing different papers, or
 * different reviewer slots of the same paper, never touch the same file and
 * so never collide in git. `project.json` itself now holds only paper
 * metadata (see `splitProjectFiles`/`isLegacyProjectShape` in
 * `src/model/project.ts`).
 *
 * The renderer's `loadProject` still only knows the old, single-blob shape —
 * deliberately: it is already exhaustively validated/defaulted/error-friendly
 * for that shape, and duplicating that logic for a split-file shape would be
 * the exact "two implementations of one fact" this codebase avoids elsewhere.
 * So this file does the reassembly: walk `annotations/`, splice each paper's
 * files back into its `papers[i]`, and hand the renderer one JSON text in the
 * shape it already parses. A project still in the pre-v1.3 single-file shape
 * (`isLegacyProjectShape`) needs no reassembly at all — it already *is* that
 * shape — and is passed through untouched; it migrates to the split layout
 * automatically the next time it is saved (`project:save` below always
 * writes the split layout).
 */

/**
 * Resolve `relPath` under `annotationsDir` and read it, refusing anything
 * that resolves (directly, or via a symlink somewhere in the chain) outside
 * `annotationsDir` — the same "received material, might contain a symlink
 * escape" defense as `resolveProjectPath` applies to PDFs, since a shared
 * project's `annotations/` folder is exactly as untrusted. Returns `null` for
 * "not there" or "escapes the folder" alike: both mean "no file", not an
 * error — a paper simply not yet annotated by a given reviewer looks the same
 * either way.
 */
async function safeReadAnnotationFile(annotationsDir: string, relPath: string): Promise<string | null> {
  const resolved = path.resolve(annotationsDir, relPath)
  const base = path.resolve(annotationsDir)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null
  let real: string
  let realBase: string
  try {
    real = await realpath(resolved)
    realBase = await realpath(base)
  } catch {
    return null
  }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) return null
  try {
    return await readFile(real, 'utf-8')
  } catch {
    return null
  }
}

/** Matches a per-reviewer annotation file's name for an ordinary (non-screening)
 *  project — `reviewer-<n>.json` (see `splitProjectFiles`'s doc comment for why
 *  a screening project uses a different prefix). Group 1 is the reviewer number. */
const REVIEWER_FILE_RE = /^reviewer-(\d+)\.json$/

/** Matches a per-reviewer annotation file's name for a screening project —
 *  `screening-<n>.json` (see `splitProjectFiles`'s doc comment for why an
 *  ordinary project uses a different prefix). Group 1 is the reviewer number. */
const SCREENING_FILE_RE = /^screening-(\d+)\.json$/

/** Matches a per-reviewer PDF-marks file's name — `marks-<n>.json`, the same
 *  regardless of screening vs. annotation mode (see `splitProjectFiles`'s
 *  doc comment for why marks don't share the reviewer/screening split).
 *  Group 1 is the reviewer number. */
const MARKS_FILE_RE = /^marks-(\d+)\.json$/

type PaperFiles = {
  consolidated?: unknown
  reviewers: Map<string, unknown>
  marksConsolidated?: unknown
  reviewMarks: Map<string, unknown>
}

/** Every reviewer/consolidated/marks file present for one paper, read and
 *  parsed defensively — a corrupt file is skipped, not thrown over, same as
 *  a corrupt field anywhere else in a hand-editable project. Reads only the
 *  file names this project's own kind (`screening`) owns, never the other
 *  kind's — so a sibling project sharing the same `annotations/` folder can
 *  never shadow this one's reviewer/consolidated data on read. */
async function loadPaperFiles(annotationsDir: string, paperId: string, screening: boolean): Promise<PaperFiles> {
  const reviewers = new Map<string, unknown>()
  const reviewMarks = new Map<string, unknown>()
  let consolidated: unknown
  let marksConsolidated: unknown
  const consolidatedName = screening ? 'screening-consolidated.json' : 'consolidated.json'
  const consolidatedText = await safeReadAnnotationFile(annotationsDir, `${paperId}/${consolidatedName}`)
  if (consolidatedText !== null) {
    try {
      consolidated = JSON.parse(consolidatedText)
    } catch {
      // corrupt file — treat as absent
    }
  }
  const marksConsolidatedText = await safeReadAnnotationFile(annotationsDir, `${paperId}/marks-consolidated.json`)
  if (marksConsolidatedText !== null) {
    try {
      marksConsolidated = JSON.parse(marksConsolidatedText)
    } catch {
      // corrupt file — treat as absent
    }
  }
  const paperDirResolved = path.resolve(annotationsDir, paperId)
  const base = path.resolve(annotationsDir)
  let entries: Array<{ name: string; isFile(): boolean }> = []
  if (paperDirResolved === base || paperDirResolved.startsWith(base + path.sep)) {
    try {
      entries = await readdir(paperDirResolved, { withFileTypes: true })
    } catch {
      entries = []
    }
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const reviewerMatch = (screening ? SCREENING_FILE_RE : REVIEWER_FILE_RE).exec(entry.name)
    const marksMatch = MARKS_FILE_RE.exec(entry.name)
    if (!reviewerMatch && !marksMatch) continue
    const text = await safeReadAnnotationFile(annotationsDir, `${paperId}/${entry.name}`)
    if (text === null) continue
    try {
      if (reviewerMatch) reviewers.set(reviewerMatch[1], JSON.parse(text))
      else reviewMarks.set(marksMatch![1], JSON.parse(text))
    } catch {
      // corrupt file — skip this reviewer's tree
    }
  }
  return { consolidated, reviewers, marksConsolidated, reviewMarks }
}

/** Read `filePath`'s `project.json` and, if it's the split (post-v1.3) shape,
 *  reassemble its `annotations/` folder into the legacy whole-project text
 *  `loadProject` accepts. A pre-v1.3 file is returned exactly as read. */
async function readProjectText(filePath: string): Promise<string> {
  const text = await readFile(filePath, 'utf-8')
  const raw: unknown = JSON.parse(text)
  if (isLegacyProjectShape(raw)) return text
  const papers = (raw as { papers?: unknown[] }).papers
  const annotationsDir = path.join(path.dirname(filePath), 'annotations')
  const screening = Boolean((raw as { config?: { screening?: unknown } })?.config?.screening)
  const paperFiles = new Map<string, PaperFiles>()
  for (const p of Array.isArray(papers) ? papers : []) {
    const id = (p as { id?: unknown })?.id
    if (typeof id !== 'string') continue
    paperFiles.set(id, await loadPaperFiles(annotationsDir, id, screening))
  }
  return JSON.stringify(assembleLegacyProjectJson(raw, paperFiles))
}

/** Absolute project-file paths `project:save` will actually write to — every
 *  path this session has legitimately opened (read successfully as a project)
 *  or chosen as a fresh Save-As target. Without this, `project:save` would
 *  write attacker-chosen content to any absolute path the renderer named. */
const knownProjectPaths = new Set<string>()

ipcMain.handle('project:open', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Open SLR project',
    filters: [{ name: 'SLR project', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const filePath = res.filePaths[0]
  const text = await readProjectText(filePath)
  knownProjectPaths.add(path.resolve(filePath))
  return { path: filePath, text }
})

ipcMain.handle('project:openPath', async (_e, filePath: string) => {
  try {
    const text = await readProjectText(filePath)
    knownProjectPaths.add(path.resolve(filePath))
    return { path: filePath, text }
  } catch {
    return null // file moved/deleted/unreadable/corrupt
  }
})

/**
 * Refuse to write through a symlink.
 *
 * `writeFile` follows one, so it writes the *target*, wherever that is. A
 * project folder can arrive by zip, USB, or shared drive with symlinks already
 * in it, and one write path is never confirmed by a dialog: the sibling
 * `<name>-fulltext.json` that "Start full-text screening" derives from the
 * project's own location. Shipping that name as a symlink to `~/.zshrc` turned
 * one click into an overwrite of a startup file — with substantially
 * attacker-chosen content, since `serializeProject` round-trips unknown keys
 * verbatim. Checked with `lstat`, which reports the link itself rather than
 * what it points at.
 */
async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    const st = await lstat(filePath)
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing to write to "${filePath}": it is a symbolic link, and writing would modify the file it points at instead.`,
      )
    }
  } catch (err) {
    // Not existing yet is the ordinary case for a new file — only a real lstat
    // failure other than ENOENT, or our own refusal above, should propagate.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }
}

/**
 * Refuse a write whose resolved location is outside `root`.
 *
 * `assertNotSymlink` only inspects the final component, which leaves the
 * directory case open: a repository carrying `sub -> /somewhere/else` accepts a
 * relative path of `sub/project.json` — `assertRelPath` sees no `..`, and the
 * leaf really is an ordinary file — and the write lands outside the repository.
 * Resolving the *parent* with `realpath` follows every link in the chain, so
 * containment is checked against where the write actually goes rather than
 * where the path string claims it goes.
 *
 * The parent must exist, which it always does here: these are writes into a
 * repository git has already populated.
 */
async function assertInsideRoot(root: string, filePath: string): Promise<void> {
  const base = await realpath(root)
  let parent: string
  try {
    parent = await realpath(path.dirname(filePath))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Refusing to write to "${filePath}": its folder does not exist.`)
    }
    throw err
  }
  if (parent !== base && !parent.startsWith(base + path.sep)) {
    throw new Error(
      `Refusing to write to "${filePath}": it resolves to "${parent}", outside the repository.`,
    )
  }
}

/**
 * Write `project.json` (`metaText`) plus reconcile the `annotations/` folder
 * against `files`: a non-null entry is written (its paper folder created if
 * new), a null entry is deleted if present. `files` always lists every
 * possible reviewer/consolidated slot for every paper (see
 * `splitProjectFiles`) — this reconciles the whole folder to match the
 * project state being written on every call, rather than tracking which
 * trees changed since the last one.
 * ponytail: O(papers × reviewers) fs calls per write; fine for the corpora
 * sizes this tool targets, revisit with per-tree dirty tracking if autosave
 * on very large projects turns out to be slow.
 *
 * Shared by `project:save` and every git handler that needs to put a specific
 * (committed, or working-tree-after-commit) project state onto disk —
 * `git:commitPartial`'s write→add→commit→restore swap and `git:pullFinish`'s
 * merge result both go through this, so "how a split project is written" has
 * exactly one implementation.
 */
async function writeProjectFiles(
  filePath: string,
  metaText: string,
  files: Array<{ relPath: string; text: string | null }>,
): Promise<void> {
  await assertNotSymlink(filePath)
  await writeFile(filePath, metaText, 'utf-8')

  const annotationsDir = path.join(path.dirname(filePath), 'annotations')
  await mkdir(annotationsDir, { recursive: true })
  const realAnnotationsDir = await realpath(annotationsDir)
  for (const file of files) {
    const target = path.resolve(annotationsDir, file.relPath)
    const base = path.resolve(annotationsDir)
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new Error(`Refusing to write annotation file outside the project: "${file.relPath}"`)
    }
    if (file.text === null) {
      try {
        await unlink(target)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      continue
    }
    await mkdir(path.dirname(target), { recursive: true })
    // Re-resolve through any symlink now that the parent is guaranteed to
    // exist, the same "trust the real destination, not the path string"
    // check `resolveProjectPath`/`safeReadAnnotationFile` apply on read.
    const realParent = await realpath(path.dirname(target))
    if (realParent !== realAnnotationsDir && !realParent.startsWith(realAnnotationsDir + path.sep)) {
      throw new Error(`Refusing to write annotation file outside the project: "${file.relPath}"`)
    }
    await assertNotSymlink(target)
    await writeFile(target, file.text, 'utf-8')
  }
}

ipcMain.handle(
  'project:save',
  async (_e, filePath: string, metaText: string, files: Array<{ relPath: string; text: string | null }>) => {
    if (!knownProjectPaths.has(path.resolve(filePath))) {
      throw new Error(`Refusing to save to "${filePath}": it was not opened or chosen via a dialog this session.`)
    }
    await writeProjectFiles(filePath, metaText, files)
  },
)

ipcMain.handle('project:setDir', (_e, filePath: string) => {
  const dir = path.dirname(filePath)
  // A path approved for one project's directory says nothing about a
  // different one that happens to store the same relative path — but
  // `getPdfSource` re-asserts the *same* directory on every PDF load (see
  // its own comment), so clearing unconditionally would re-prompt for an
  // already-approved path every time the reviewer switched back to it.
  if (dir !== projectDir) allowedEscapes.clear()
  projectDir = dir
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
  knownProjectPaths.add(path.resolve(res.filePath))
  return { path: res.filePath }
})

/**
 * Would writing a project to `destPath` start sharing an `annotations/`
 * folder with another, unrelated project already sitting in that directory?
 * Two *different* project kinds sharing paper ids on purpose (SaiLoR's own
 * "Start full-text screening" flow) never actually collide on a filename —
 * one writes `screening-N.json`, the other `reviewer-N.json`, for the same
 * paper id — so this only flags a **same-family** overlap: another project
 * file, of the same screening/non-screening kind, that shares at least one
 * paper id. Called from `saveAs()` right after the destination is picked and
 * before anything is written — the only moment a new sharing relationship
 * can be created; it cannot retroactively protect a folder two projects
 * already share from an earlier, unguarded Save As.
 *
 * Not git-specific — Save As works with no repository at all — so this
 * lives in the plain `project:*` namespace like `pickSavePath` above it,
 * not alongside the `git:*` handlers.
 */
ipcMain.handle(
  'project:checkSiblingCollision',
  async (_e, destPath: string, paperIds: string[], screening: boolean) => {
    const destDir = path.dirname(destPath)
    const destName = path.basename(destPath)
    let entries: string[]
    try {
      entries = await readdir(destDir)
    } catch {
      return null // destination directory doesn't exist yet — nothing to collide with
    }
    const ownIds = new Set(paperIds)
    for (const name of entries) {
      if (name === destName || !name.endsWith('.json')) continue
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(path.join(destDir, name), 'utf-8'))
      } catch {
        continue // not a project file (or not readable) — not our concern
      }
      const candidatePapers = (raw as { papers?: unknown[] } | null)?.papers
      if (!Array.isArray(candidatePapers)) continue
      const candidateScreening = Boolean((raw as { config?: { screening?: unknown } })?.config?.screening)
      if (candidateScreening !== screening) continue // different family — filenames can't collide
      const overlapping: string[] = []
      for (const p of candidatePapers) {
        const id = (p as { id?: unknown } | null)?.id
        if (typeof id === 'string' && ownIds.has(id)) overlapping.push(id)
      }
      if (overlapping.length > 0) return { siblingName: name, overlappingIds: overlapping }
    }
    return null
  },
)

/** Absolute paths `pdf:read` will actually read — every path this session has
 *  handed back from `pdf:pick`/`pdf:pickFolder`, both native dialogs. Reading
 *  a PDF's bytes (for title/author extraction) is otherwise "any absolute
 *  path the renderer names," which a compromised renderer could point at any
 *  file on disk; this narrows it to "a file the reviewer actually selected." */
const readablePdfPaths = new Set<string>()

ipcMain.handle('pdf:pick', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Add PDFs',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  })
  if (res.canceled) return []
  res.filePaths.forEach((p) => readablePdfPaths.add(path.resolve(p)))
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
  const paths = await collectPdfsRecursive(res.filePaths[0])
  paths.forEach((p) => readablePdfPaths.add(path.resolve(p)))
  return paths
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
// may pick PDFs from anywhere, and they chose the file via a native dialog —
// which `readablePdfPaths` is what actually enforces: only a path this
// session handed back from that dialog is readable here.
ipcMain.handle('pdf:read', async (_e, filePath: string) => {
  if (!readablePdfPaths.has(path.resolve(filePath))) {
    throw new Error(`"${filePath}" was not selected via a file picker.`)
  }
  const buf = await readFile(filePath)
  // Return a plain Uint8Array; Buffer doesn't survive the IPC boundary intact.
  return new Uint8Array(buf)
})

// Lets the renderer ask, before ever constructing an slr-file:// URL, whether
// a paper's `pdf` value is reachable — same check `registerPdfProtocol` makes
// when actually serving it, just without reading the file. A blocked or
// missing PDF then gets a specific, honest reason (see `getPdfSource` in
// src/platform/electron.ts) instead of pdf.js's own opaque failure for
// whatever HTTP status the protocol handler answered with.
ipcMain.handle('pdf:checkPath', async (_e, rel: string) => {
  const check = await resolveProjectPath(rel)
  return check.ok ? { ok: true } : { ok: false, reason: check.reason }
})

// Asks the reviewer whether to open a PDF that points outside the project's
// own folder, and — only on "yes" — records it so `resolveProjectPath` stops
// refusing this *specific* path for the rest of this session. The dialog
// lives here, not in the renderer: a compromised renderer must not be able to
// self-approve its own escape by simply calling this with no confirmation at
// all — the `window.confirm` this replaced could be skipped by calling the
// bridge method directly. Scoped to the currently-open project's directory;
// see `allowedEscapes`'s own comment.
ipcMain.handle('pdf:allowPath', async (_e, rel: string) => {
  if (!mainWindow) return false
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Open anyway'],
    defaultId: 0,
    cancelId: 0,
    message: `PDF "${rel}" is stored outside this project's own folder.`,
    detail:
      `Opening it means reading a file at a path the project itself names. If you didn't author this ` +
      `project yourself — it came from a collaborator, or somewhere else — that path could point at a file ` +
      `on your disk you didn't intend to share. Only continue if you trust where this project came from.`,
  })
  if (response !== 1) return false
  allowedEscapes.add(rel)
  return true
})

// ---- PDF export: burn PdfMarks into real PDF annotation objects ----
//
// A one-way, user-triggered export — see src/model/pdfMarks.ts's doc comment
// for why the live in-app overlay deliberately does NOT do this. pdf-lib has
// no high-level "add a Highlight annotation" API, so the annotation
// dictionaries are built by hand via its low-level PDFContext API.

/** `#rrggbb` → `[r, g, b]` floats 0..1, for a PDF `/C` color array. Malformed
 *  input (a hand-edited file's `color` need not be one of `MARK_COLORS`)
 *  falls back to a highlighter yellow rather than failing the export. */
function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return [1, 0.88, 0.4]
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
}

/** A mark's comment, PDFHexString-encoded so it survives non-ASCII (pdf-lib's
 *  `PDFHexString.fromText` UTF-16BE-encodes it, unlike a literal `PDFString`). */
function contentsOf(mark: PdfMark): PDFHexString {
  return PDFHexString.fromText(mark.comment)
}

/** A mark's `createdAt`/`updatedAt` as a PDF date string, or `undefined` when
 *  absent/unparseable — `context.obj` drops `undefined` entries rather than
 *  writing a broken date. */
function pdfDateOf(iso: string): PDFString | undefined {
  if (!iso) return undefined
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? undefined : PDFString.fromDate(d)
}

/** A `Highlight` annotation dict for one mark — `/Rect` is the union of all
 *  its rects' bounding boxes (a multi-line selection), `/QuadPoints` carries
 *  each line's own quad (§8.4.5) so the highlight follows the text shape
 *  rather than one wide box. `/CA 0.4` keeps it translucent, so it reads as
 *  a highlighter stroke rather than a solid block. */
function buildHighlightAnnotDict(context: PDFContext, mark: PdfMark, pageWidth: number, pageHeight: number): PDFDict {
  const quadPoints: number[] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const rect of mark.rects) {
    quadPoints.push(...rectToQuadPoints(rect, pageWidth, pageHeight))
    const p = rectToPdfPoints(rect, pageWidth, pageHeight)
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + p.width)
    maxY = Math.max(maxY, p.y + p.height)
  }
  const [r, g, b] = hexToRgb01(mark.color)
  return context.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [minX, minY, maxX, maxY],
    QuadPoints: quadPoints,
    C: [r, g, b],
    CA: 0.4,
    Contents: contentsOf(mark),
    T: PDFString.of('SaiLoR'),
    CreationDate: pdfDateOf(mark.createdAt),
    M: pdfDateOf(mark.updatedAt),
  })
}

/** A `Text` ("sticky note") annotation dict for one note mark. Its rect's
 *  `width`/`height` are a placeholder (see `MarkRect`'s doc comment) — only
 *  `x`/`y`, the pinned point, is trusted; the icon itself is a small fixed
 *  box centered on it, since the reader draws its own icon glyph regardless
 *  of the `/Rect` size. */
function buildTextAnnotDict(context: PDFContext, mark: PdfMark, pageWidth: number, pageHeight: number): PDFDict {
  const ICON = 20
  const point = rectToPdfPoints({ ...mark.rects[0], width: 0, height: 0 }, pageWidth, pageHeight)
  const [r, g, b] = hexToRgb01(mark.color)
  return context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [point.x - ICON / 2, point.y - ICON / 2, point.x + ICON / 2, point.y + ICON / 2],
    Name: 'Comment',
    C: [r, g, b],
    Contents: contentsOf(mark),
    T: PDFString.of('SaiLoR'),
    CreationDate: pdfDateOf(mark.createdAt),
    M: pdfDateOf(mark.updatedAt),
    Open: false,
  })
}

/** Build and append one annotation per mark, grouped by page. A mark whose
 *  `page` is beyond what this PDF actually has is skipped — the marks and
 *  the PDF bytes are two files a reviewer might have edited independently
 *  (the "annotated" export was regenerated from a shorter/longer PDF), and
 *  failing the whole export over one stale mark would lose every other one.
 *  Appends to each page's existing `/Annots` (via pdf-lib's own
 *  `addAnnot`, which creates the array if absent) rather than replacing it,
 *  so annotations already in the PDF survive. */
function embedMarksIntoPdf(pdfDoc: PDFDocument, marks: PdfMark[]): void {
  const pages = pdfDoc.getPages()
  const byPage = new Map<number, PdfMark[]>()
  for (const mark of marks) {
    const list = byPage.get(mark.page)
    if (list) list.push(mark)
    else byPage.set(mark.page, [mark])
  }
  for (const [pageNum, pageMarks] of byPage) {
    const page = pages[pageNum - 1]
    if (!page) continue
    const { width, height } = page.getSize()
    for (const mark of pageMarks) {
      const dict =
        mark.kind === 'note'
          ? buildTextAnnotDict(pdfDoc.context, mark, width, height)
          : buildHighlightAnnotDict(pdfDoc.context, mark, width, height)
      page.node.addAnnot(pdfDoc.context.register(dict))
    }
  }
}

/** Absolute paths this session has handed back from `pdf:pickExportPath`/
 *  `text:pickExportPath` — the only "export to a new file" destinations
 *  `pdf:embedMarks`/`text:write` will write to. Writing over the paper's own
 *  PDF (`pdf:embedMarks`'s `'original'` target) is unaffected: that
 *  destination is the project's own referenced PDF, not a fresh path a
 *  compromised renderer could otherwise invent. */
const writableExportPaths = new Set<string>()

ipcMain.handle(
  'pdf:embedMarks',
  async (
    _e,
    pdfAbsPath: string,
    marksRaw: unknown,
    target: 'original' | { newPath: string },
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    const dest = target === 'original' ? pdfAbsPath : target.newPath
    if (target !== 'original' && !writableExportPaths.has(path.resolve(dest))) {
      return { ok: false, error: `"${dest}" was not chosen via the export dialog.` }
    }
    const marks = parseMarks(marksRaw)
    let pdfDoc: PDFDocument
    try {
      const bytes = await readFile(pdfAbsPath)
      pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: false })
    } catch (err) {
      return { ok: false, error: `Could not open the PDF: ${err instanceof Error ? err.message : String(err)}` }
    }
    embedMarksIntoPdf(pdfDoc, marks)
    try {
      await assertNotSymlink(dest)
      await writeFile(dest, await pdfDoc.save())
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    return { ok: true, path: dest }
  },
)

ipcMain.handle('pdf:pickExportPath', async (_e, suggestedName: string) => {
  const res = await dialog.showSaveDialog({
    title: 'Export annotated PDF',
    defaultPath: suggestedName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (res.canceled || !res.filePath) return null
  writableExportPaths.add(path.resolve(res.filePath))
  return res.filePath
})

ipcMain.handle('text:pickExportPath', async (_e, suggestedName: string) => {
  const res = await dialog.showSaveDialog({
    title: 'Export as text',
    defaultPath: suggestedName,
    filters: [{ name: 'Text', extensions: ['txt'] }],
  })
  if (res.canceled || !res.filePath) return null
  writableExportPaths.add(path.resolve(res.filePath))
  return res.filePath
})

ipcMain.handle(
  'text:write',
  async (_e, absPath: string, text: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    if (!writableExportPaths.has(path.resolve(absPath))) {
      return { ok: false, error: `"${absPath}" was not chosen via the export dialog.` }
    }
    try {
      await assertNotSymlink(absPath)
      await writeFile(absPath, text, 'utf8')
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    return { ok: true, path: absPath }
  },
)

// ---- Self-update (Windows/Linux only) ----
//
// macOS is excluded: electron-updater's Squirrel.Mac path needs the
// downloaded update to pass Gatekeeper, which needs a real Apple Developer ID
// signature *and* notarization — this project only ad-hoc-signs on mac (see
// afterPack.cjs), so a real auto-installed update would show up as "damaged."
// Mac keeps the existing check-only banner (src/model/version.ts) untouched.
//
// Nothing here runs on its own: `autoDownload`/`autoInstallOnAppQuit` are both
// off, so a download only starts when the renderer calls `update:download`
// (the reviewer clicked "Download update"), and installing only happens on
// `update:install` ("Restart to update").
if (process.platform !== 'darwin') {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update:available', { version: info.version })
  })
  autoUpdater.on('download-progress', (p) => {
    mainWindow?.webContents.send('update:progress', { percent: p.percent })
  })
  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('update:downloaded')
  })
  autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('update:error', err instanceof Error ? err.message : String(err))
  })
}

ipcMain.handle('update:check', async () => {
  if (process.platform === 'darwin') return { supported: false }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    // Failure is reported to the renderer via the 'error' listener above;
    // the check itself failing silently here is fine — there's nothing more
    // useful to return, and the manual download link stays available either way.
    mainWindow?.webContents.send('update:error', err instanceof Error ? err.message : String(err))
  }
  return { supported: true }
})

ipcMain.handle('update:download', () => {
  if (process.platform === 'darwin') return
  void autoUpdater.downloadUpdate()
})

ipcMain.handle('update:install', () => {
  if (process.platform === 'darwin') return
  autoUpdater.quitAndInstall()
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
// Registers the result as a legitimate `project:save` target: `sourceFile`
// must already be a project this session knows about, and `fileName` must be
// a plain file name with no path separators — so this can only ever name a
// fresh file in that same, already-known directory, never an arbitrary path.
ipcMain.handle('paths:sibling', (_e, sourceFile: string, fileName: string) => {
  if (!knownProjectPaths.has(path.resolve(sourceFile))) {
    throw new Error(`"${sourceFile}" is not a project this session has open.`)
  }
  const safeName = path.basename(fileName)
  if (!safeName || safeName !== fileName) {
    throw new Error(`"${fileName}" is not a valid file name.`)
  }
  const result = path.join(path.dirname(sourceFile), safeName)
  knownProjectPaths.add(path.resolve(result))
  return result
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
  // This app has no legitimate use for camera/mic/geolocation/notifications/
  // etc. — deny every permission request rather than let Chromium's defaults
  // (which allow some of these with a user prompt) apply to a window that
  // renders untrusted PDFs.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
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

/**
 * How long any single LLM call may take before it is aborted. Generous: a
 * large paper against a slow reasoning model legitimately takes minutes, and
 * cutting off real work is worse than waiting.
 */
const LLM_TIMEOUT_MS = 10 * 60 * 1000

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
    // Opaque-origin schemes compare equal to each other — `new URL('file:///a')
    // .origin` and `new URL('file://x/b').origin` are both the string "null" —
    // so without a scheme check a `file:` base URL would authorise any `file:`
    // target and turn this into a file reader. Only the two schemes an API
    // endpoint can actually use are allowed.
    if (!['https:', 'http:'].includes(target.protocol) || target.protocol !== allowed.protocol) {
      throw new Error(`Refusing to send the API key over ${target.protocol}.`)
    }
    if (target.origin !== allowed.origin) {
      throw new Error(`Refusing to send the API key to ${target.origin}.`)
    }

    const apiKey = decryptKey(config.key)
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [k, v.split(API_KEY_SENTINEL).join(apiKey)]),
    )

    const controller = new AbortController()
    inFlight.set(requestId, controller)
    // An endpoint that accepts the connection and then never answers would
    // otherwise hang forever: `fetch` has no default timeout, and the two
    // calls that are not the main annotation run — listing models and
    // verifying a target — pass no signal of their own and offer the reviewer
    // no way to give up. A misconfigured self-hosted endpoint is the ordinary
    // way to reach this, not a hostile one.
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
    try {
      const res = await net.fetch(request.url, {
        method: request.method ?? 'POST',
        headers,
        body: request.method === 'GET' ? undefined : request.body,
        signal: controller.signal,
        // The origin check above happens once, before the request. Following a
        // redirect would carry these headers — including the substituted API
        // key — to whatever origin the endpoint names, so the check would guard
        // only the first hop. Provider-specific key headers (`x-api-key`,
        // `x-goog-api-key`) are *not* stripped by the fetch stack the way
        // `Authorization` is, so this is a real leak and not a theoretical one.
        // Refuse the redirect instead: an API endpoint that redirects is
        // misconfigured, and reporting that is more useful than silently
        // following it somewhere else.
        redirect: 'error',
      })
      return { ok: res.ok, status: res.status, body: await res.text() }
    } finally {
      clearTimeout(timer)
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
/**
 * Config git must not take from the repository it is run in.
 *
 * `gitEnv` strips the inherited environment, but the repository's *own*
 * `.git/config` is read before git does anything — and several of its keys are
 * commands git runs. The threat model is not hypothetical: the app's own
 * documentation describes receiving a project folder, and a folder that arrives
 * by zip, USB, or shared drive brings its `.git/` with it. A hostile
 * `core.fsmonitor` runs on `git status`, which the Git button reaches in one
 * click, and `git:info` fires automatically on project open. Verified: a
 * `core.fsmonitor` of `printf PWNED > /tmp/proof; false` wrote the file.
 * `safe.directory` does not help — the copied folder belongs to the reviewer.
 *
 * `-c` beats every config file, so this is a hard override rather than a
 * request. Only keys with no legitimate value for this app are listed: it never
 * wants a pager, an editor, an external diff, or a filesystem monitor. Keys a
 * user may legitimately set globally — `core.sshCommand`, `credential.helper`,
 * `gpg.program` — are deliberately left alone, since overriding them here would
 * break ordinary setups; they run only on an explicit network action the user
 * asked for, not on merely opening a folder, which is the boundary that
 * matters. `.git/hooks` is covered by `core.hooksPath`; `filter.*` drivers
 * cannot be disabled by `-c` and remain the known residual, reachable only on
 * an explicit commit or pull.
 */
const GIT_SAFE_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${path.join(os.tmpdir(), 'sailor-no-hooks-does-not-exist')}`,
  '-c', 'core.pager=cat',
  '-c', 'core.editor=false',
  '-c', 'core.alternateRefsCommand=',
  '-c', 'uploadpack.packObjectsHook=',
  '-c', 'protocol.ext.allow=never',
]
// `diff.external` is deliberately NOT in that list. Setting it empty makes git
// try to run the empty string — "cannot run : No such file or directory", and
// the diff dies — so an attacker's external differ would be swapped for a
// guaranteed failure rather than the built-in one. `--no-ext-diff` on the diff
// itself is the mechanism that actually means "use your own", and it is passed
// where the diff is run.
//
// `--no-textconv` is passed there for the same reason and is not optional.
// `diff.<driver>.textconv` is selected by an in-tree `.gitattributes`, so `-c`
// cannot pre-empt it and `--no-ext-diff` does not cover it — they are separate
// mechanisms. Verified: a received folder carrying `* diff=evil` plus a
// `diff.evil.textconv` in its own config executes that command on `git status`,
// which is one click from opening the project, exactly like the `core.fsmonitor`
// case above.

function runGit(args: string[], cwd?: string, timeout = GIT_TIMEOUT_MS): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_SAFE_CONFIG, ...args],
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
  // The rule itself lives in `src/git/relpath.ts` so the test suite can reach
  // it — `electron/` is outside vitest's include. Same arrangement as
  // `validateGitUrl`, and for the same reason: a security gate with no tests is
  // a security gate nobody can change safely.
  const problem = relPathProblem(p)
  if (problem) throw new Error(`Refusing to act on the path "${p}" (${problem}).`)
}

/** A ref the renderer named. Every ref it can name came out of `git:branches`,
 *  so this only ever fires on a value that did not — which is exactly the case
 *  worth refusing. Rule in `src/git/ref.ts`, for the same testability reason as
 *  `assertRelPath` above. */
function assertRef(ref: string): void {
  const problem = refProblem(ref)
  if (problem) throw new Error(`Refusing to act on the ref "${ref}" (${problem}).`)
}

/** Repository roots this session has actually resolved via `git:info` (a
 *  project the reviewer opened) or `git:clone` (a repository this app itself
 *  just cloned) — populated below in those two handlers. A handler that
 *  switches or checks out a branch is told `root` by the renderer, and
 *  without this it would run against whatever directory a compromised
 *  renderer named, not one this session ever actually opened. */
const knownGitRoots = new Set<string>()

function assertRoot(root: string): void {
  if (!knownGitRoots.has(path.resolve(root))) {
    throw new Error(`Refusing to act on "${root}": not a repository this session opened.`)
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
  if (r.ok) knownGitRoots.add(path.resolve(dest))
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
  if (root) knownGitRoots.add(path.resolve(root))
  return { root, relPath, branch, upstream, hasHead }
})

ipcMain.handle('git:status', async (_e, root: string) => {
  const porcelain = (await runGit(['status', '--porcelain=v1', '-z'], root)).stdout
  const hasHead = (await runGit(['rev-parse', '--verify', '-q', 'HEAD'], root)).ok
  // --no-color: a user with color.diff=always would otherwise leak ANSI escape
  // sequences into the <pre> as literal text. --no-pager costs one token and
  // removes a whole class of hang.
  const diff = hasHead
    ? (await runGit(['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--'], root)).stdout
    : ''
  return { porcelain, diff }
})

/**
 * `readProjectText`'s counterpart for a git revision instead of the working
 * directory: `project.json` plus every `annotations/<paperId>/*.json` file,
 * all read via `git show <rev>:<path>` rather than the filesystem, reassembled
 * into the same legacy whole-project text `loadProject` accepts. `null` when
 * `relPath` has no such revision at all (e.g. HEAD before the first commit).
 */
async function readProjectAtRevision(root: string, relPath: string, rev: string): Promise<string | null> {
  const show = await runGit(['show', `${rev}:${relPath}`], root)
  if (!show.ok) return null
  const text = show.stdout
  const raw: unknown = JSON.parse(text)
  if (isLegacyProjectShape(raw)) return text

  const dir = annotationsRelDir(relPath)
  const lsTree = await runGit(['ls-tree', '-r', '--name-only', rev, '--', dir], root)
  const paths = lsTree.ok ? lsTree.stdout.split('\n').filter(Boolean) : []

  const papers = (raw as { papers?: unknown[] }).papers
  const screening = Boolean((raw as { config?: { screening?: unknown } })?.config?.screening)
  const paperFiles = new Map<string, PaperFiles>()
  for (const p of Array.isArray(papers) ? papers : []) {
    const id = (p as { id?: unknown })?.id
    if (typeof id === 'string') paperFiles.set(id, { reviewers: new Map(), reviewMarks: new Map() })
  }
  const consolidatedName = screening ? 'screening-consolidated' : 'consolidated'
  const reviewerPrefix = screening ? 'screening' : 'reviewer'
  const re = new RegExp(`^([^/]+)\\/(?:(${consolidatedName})|${reviewerPrefix}-(\\d+)|(marks-consolidated)|marks-(\\d+))\\.json$`)
  for (const p of paths) {
    const rel = p.slice(dir.length + 1) // "<paperId>/<name>.json"
    // Group 2 catches this project's own consolidated-file name (ordinary or
    // screening, whichever this revision's `config.screening` says); group 3
    // catches the reviewer number for this project's own reviewer-file prefix
    // (see `splitProjectFiles`'s doc comment for why a screening project uses
    // a different prefix); group 4 catches marks-consolidated; group 5 the
    // reviewer number for a marks-<n> file (marks don't split by screening).
    // A file belonging to the other project kind simply doesn't match.
    const m = re.exec(rel)
    if (!m) continue
    const [, paperId, consolidatedKind, reviewerNum, marksConsolidatedKind, marksReviewerNum] = m
    const entry = paperFiles.get(paperId)
    if (!entry) continue
    const fileShow = await runGit(['show', `${rev}:${p}`], root)
    if (!fileShow.ok) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(fileShow.stdout)
    } catch {
      continue // corrupt file at this revision — treat as absent
    }
    if (consolidatedKind) entry.consolidated = parsed
    else if (reviewerNum) entry.reviewers.set(reviewerNum, parsed)
    else if (marksConsolidatedKind) entry.marksConsolidated = parsed
    else entry.reviewMarks.set(marksReviewerNum, parsed)
  }
  return JSON.stringify(assembleLegacyProjectJson(raw, paperFiles))
}

/** HEAD's copy of the project, reassembled from `project.json` plus
 *  `annotations/` at HEAD, for the commit panel's field-level review
 *  (`src/git/changes.ts` diffs this against the working copy already in
 *  memory). `null` when `relPath` has no HEAD revision at all — a newly
 *  added, still-untracked project — in which case the caller falls back to
 *  the plain whole-file commit, the same as it already does for any file
 *  that fails to parse as a project on either side. */
ipcMain.handle('git:headContent', async (_e, root: string, relPath: string) => {
  assertRelPath(relPath)
  return readProjectAtRevision(root, relPath, 'HEAD')
})

/**
 * The working tree's own content, reassembled directly from disk rather than
 * through `store.ts`'s in-memory `project` — which may hold unsaved edits the
 * reviewer never saved — and rather than git, unlike `git:headContent`: this
 * is deliberately the same reassembly `project:openPath` does (`readProjectText`),
 * not `git show :relPath` (the index's copy, a different and for this feature
 * wrong thing to diff), so what the commit panel reviews is what's really on disk.
 */
ipcMain.handle('git:workingContent', async (_e, root: string, relPath: string) => {
  assertRelPath(relPath)
  try {
    return await readProjectText(path.join(root, relPath))
  } catch {
    return null
  }
})

/**
 * Commit history for the open project's own file — `git log` scoped to
 * `relPath` and its `annotations/` dir, not the whole repo, matching how Pull
 * and Merge are already scoped. Capped rather than paginated: a review
 * project with more than `LOG_MAX_COMMITS` commits touching one file is a
 * problem nobody has hit yet, so `truncated` just says so rather than
 * building `--skip` support for it.
 */
const LOG_MAX_COMMITS = 250

ipcMain.handle('git:logBegin', async (_e, root: string, relPath: string) => {
  assertRelPath(relPath)
  const dir = annotationsRelDir(relPath)
  const r = await runGit(
    [
      'log',
      `--max-count=${LOG_MAX_COMMITS}`,
      '--date=iso-strict',
      '--format=%x00%H%x09%aI%x09%s',
      '--',
      relPath,
      dir,
    ],
    root,
  )
  if (!r.ok) return { commits: [], truncated: false, error: gitErrorText(r) }
  const commits = parseGitLog(r.stdout)
  return { commits, truncated: commits.length === LOG_MAX_COMMITS, error: null }
})

/**
 * The two revisions of the project a commit-history row needs to show a
 * field-level diff for: the commit itself, and its first parent. Deliberately
 * returns raw text rather than parsing it here — `loadProject`/
 * `detectFieldChanges` are renderer-side (`src/git/changes.ts`, called from
 * `gitStore.ts`), and every other IPC call in this file keeps that same
 * boundary (`git:headContent`, `git:pullBegin`'s `base`/`ours`/`theirs`):
 * this process only ever fetches; the renderer parses and diffs.
 *
 * `readProjectAtRevision` for `rev` was written for `git:headContent`, where
 * the input is always valid HEAD — its own internal `JSON.parse` is
 * unguarded there. Reused here for arbitrary historical revisions, a
 * malformed one would throw out of this handler instead of rejecting
 * cleanly, so both calls are wrapped.
 */
ipcMain.handle('git:logDiff', async (_e, root: string, relPath: string, rev: string) => {
  assertRelPath(relPath)
  if (refProblem(rev)) return { kind: 'error', message: 'Not a valid revision.' }
  let head: string | null, parent: string | null
  try {
    ;[head, parent] = await Promise.all([
      readProjectAtRevision(root, relPath, rev),
      readProjectAtRevision(root, relPath, `${rev}^`),
    ])
  } catch {
    return { kind: 'error', message: 'The project file could not be read at this revision.' }
  }
  if (head === null) return { kind: 'error', message: 'Could not read this revision.' }
  if (parent === null) return { kind: 'initial' }
  return { kind: 'texts', head, parent }
})

/**
 * Commits `committed` (`{metaText, files}`, from `splitProjectFiles`) as
 * `relPath` + `annotations/`'s content — which is not necessarily what the
 * working tree holds, or ends up holding. This is what makes committing
 * *some* of a project's field-level changes possible at all: git has no
 * native concept of staging part of a file (or part of a corpus), but nothing
 * requires the content `add` stages to be what is actually on disk.
 *
 * The sequence is write → add → commit → (always) write again: `committed`
 * goes onto disk just long enough to be staged, then `working` — the state
 * the reviewer's working tree should hold afterward, computed by
 * `composeContents` from their Use/Ignore/Discard choices — replaces it. The
 * `finally` is load-bearing: if `add` or `commit` fails partway, the working
 * tree must still end up holding `working`, never stuck mid-swap holding
 * content that was never actually staged as anything.
 *
 * `git add -- relPath annotationsDir` stages every add/modify/delete under
 * the whole folder in one call — simpler than listing exactly which files
 * changed, and correct either way since `writeProjectFiles` always reconciles
 * the folder to match the state it's writing.
 */
ipcMain.handle(
  'git:commitPartial',
  async (
    _e,
    root: string,
    relPath: string,
    committed: { metaText: string; files: Array<{ relPath: string; text: string | null }> },
    working: { metaText: string; files: Array<{ relPath: string; text: string | null }> },
    otherPaths: string[],
    message: string,
    amend: boolean,
  ) => {
    assertRelPath(relPath)
    otherPaths.forEach(assertRelPath)
    const fullPath = path.join(root, relPath)
    const dir = annotationsRelDir(relPath)
    const paths = [relPath, dir, ...otherPaths]
    try {
      await assertInsideRoot(root, fullPath)
      await writeProjectFiles(fullPath, committed.metaText, committed.files)
      const add = await runGit(['add', '--', ...paths], root)
      if (!add.ok) return add
      // `add` tolerates a directory pathspec that matches nothing; `commit` does
      // not ("pathspec 'annotations' did not match any file(s) known to git").
      // A project with no annotations at all leaves the folder existing and
      // empty, so only restrict the commit by `dir` when something is staged
      // under it (an add, a modify, or a delete — `diff --cached` still reports
      // a staged deletion, `ls-files` does not).
      const staged = await runGit(['diff', '--cached', '--name-only', '--', dir], root)
      const commitPaths = !staged.ok || gitOut(staged) ? paths : paths.filter((p) => p !== dir)
      const args = ['commit', '-m', message]
      if (amend) args.push('--amend')
      return await runGit([...args, '--', ...commitPaths], root)
    } finally {
      await assertInsideRoot(root, fullPath)
      await writeProjectFiles(fullPath, working.metaText, working.files)
    }
  },
)

/**
 * Writes `working` (`{metaText, files}`) — the state the reviewer's
 * field-level "discard" choices compose to (`composeContents`'s
 * `workingOut`, split) — to the project, WITHOUT staging or committing
 * anything. This is the "throw away these local edits" counterpart to
 * committing them: `commitPartial` always makes a commit, and a reviewer who
 * only wants to revert should not have to invent one. Deliberately not the
 * write→add→commit→restore swap `commitPartial` needs: there is no staged
 * content that differs from what the project should hold, so a failed write
 * simply leaves the reviewer's edits in place — never a half-reverted state.
 */
ipcMain.handle(
  'git:writeWorking',
  async (
    _e,
    root: string,
    relPath: string,
    working: { metaText: string; files: Array<{ relPath: string; text: string | null }> },
  ) => {
    assertRelPath(relPath)
    try {
      await assertInsideRoot(root, path.join(root, relPath))
      await writeProjectFiles(path.join(root, relPath), working.metaText, working.files)
      return { ok: true, code: 0, stdout: '', stderr: '' }
    } catch (err) {
      return { ok: false, code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  },
)

/**
 * Reverts or deletes a single changed file *other* than the project's own
 * tracked file/`annotations/` — the whole-file counterpart to that file's
 * field-level Discard. Re-derives the file's own status here rather than
 * trusting a code the renderer cached, since the working tree can have
 * changed since the panel last refreshed. An untracked file (`??`) has no
 * committed version to revert to, so discarding it means deleting it from
 * disk; a tracked, modified/deleted file reverts via the classic
 * `checkout -- <path>` file-restore idiom (this codebase never requires a
 * git new enough for `git restore`). Refuses — rather than guessing — a
 * rename (`git status` reports it as the *new* path; correctly reverting one
 * needs more than a single checkout) or an unresolved merge conflict.
 *
 * `projectRelPath` is the open project's own `relPath` — this is the real
 * guard against deleting the project's own untracked annotation files
 * (`GitDialog.tsx`'s `isProjectOwnPath` withholds the ↺ button for the same
 * paths, but that is UI, not enforcement, and the renderer must not be the
 * only thing standing between a stray click and data with no committed copy
 * to recover from). Refuses whenever `relPath` *is* `projectRelPath` or
 * falls under its `annotationsRelDir(...)`, the same wording style as the
 * rename/conflict refusal above.
 *
 * The whole body is wrapped in `try`/`catch`, unlike most handlers here:
 * `runDiscardFile` in `gitStore.ts` awaits this with no fallback of its own,
 * so an uncaught rejection would leave `panel.phase` stuck at `'working'`
 * — this is what a wholly-untracked directory used to do (`git status`
 * collapses one into a single `?? exports/` record, which reached `unlink()`
 * and threw `EISDIR`). Every failure, expected or not, comes back as an
 * ordinary `{ok: false}` instead.
 */
ipcMain.handle('git:discardFile', async (_e, root: string, relPath: string, projectRelPath: string) => {
  try {
    assertRelPath(relPath)
    const projectDir = annotationsRelDir(projectRelPath)
    if (relPath === projectRelPath || relPath === projectDir || relPath.startsWith(`${projectDir}/`)) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: "Discarding the project's own file here is not supported — use the field review above.",
      }
    }
    const st = await runGit(['status', '--porcelain=v1', '-z', '--', relPath], root)
    const [change] = parsePorcelain(st.stdout)
    if (!change) return { ok: true, code: 0, stdout: '', stderr: '' } // already clean — nothing to do
    if (change.unmerged || change.from) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: 'Discarding a merge conflict or a rename is not supported here — use git directly.',
      }
    }
    if (change.code.startsWith('?')) {
      const fullPath = path.join(root, relPath)
      await assertInsideRoot(root, fullPath)
      // A wholly-untracked directory reports as one porcelain record whose
      // path ends in "/" — a plain `unlink` on that throws EISDIR.
      if (relPath.endsWith('/')) {
        await rm(fullPath, { recursive: true, force: true })
      } else {
        await unlink(fullPath)
      }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    return await runGit(['checkout', '--', relPath], root)
  } catch (err) {
    return { ok: false, code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle(
  'git:commit',
  async (_e, root: string, paths: string[], message: string, amend: boolean) => {
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
    const args = ['commit', '-m', message]
    if (amend) args.push('--amend')
    return runGit([...args, '--', ...paths], root)
  },
)

ipcMain.handle('git:lastCommitMessage', async (_e, root: string) => {
  const r = await runGit(['log', '-1', '--format=%B'], root)
  return r.ok ? r.stdout.replace(/\n$/, '') : null
})

ipcMain.handle('git:push', async (_e, root: string) => {
  // Plain `git push`; the branch's own remote/merge config decides where. When
  // there is no upstream, git's own message names the exact command to run —
  // surfaced verbatim rather than inventing --set-upstream on the user's behalf.
  return runGit(['push'], root, GIT_NETWORK_TIMEOUT_MS)
})

/**
 * Are there uncommitted tracked changes that would block a merge? Shared by
 * every flow that merges, since a merge started over a dirty tree is a merge
 * whose abort cannot cleanly put things back.
 */
async function mergeBlockingDirtyPaths(root: string): Promise<string[]> {
  const st = await runGit(['status', '--porcelain=v1', '-z'], root)
  // Untracked files ('??') never block a merge, so they are not "dirty" here.
  return parsePorcelain(st.stdout)
    .filter((c) => c.code !== '??')
    .map((c) => c.path)
}

/**
 * Merge `ref` into the current branch, up to the point where the reviewer has
 * to decide something. A pull is one of these (`ref` = `@{u}`); so is an
 * explicit branch merge. Assumes the caller has already checked the work tree
 * is clean.
 *
 * Contract: this always returns with the repository in exactly one of two
 * states — not mid-merge, for every outcome except `'merge'`, or mid-merge
 * with nothing unmerged except the project's own files, for `'merge'`. It
 * never returns leaving a half-merge the renderer did not ask for.
 */
async function beginMergeInto(root: string, relPath: string, ref: string): Promise<MergeStart> {
  if ((await runGit(['merge-base', '--is-ancestor', ref, 'HEAD'], root)).ok) {
    return { kind: 'up-to-date' }
  }

  if ((await runGit(['merge-base', '--is-ancestor', 'HEAD', ref], root)).ok) {
    const ff = await runGit(['merge', '--ff-only', ref], root)
    return ff.ok ? { kind: 'fast-forwarded' } : { kind: 'error', message: gitErrorText(ff) }
  }

  // Divergent. Read the three revisions of the project (project.json +
  // annotations/, reassembled — see `readProjectAtRevision`) BEFORE touching
  // the work tree, so nothing that follows can change what gets merged.
  const baseRun = await runGit(['merge-base', 'HEAD', ref], root)
  const baseSha = baseRun.ok ? gitOut(baseRun) : null
  const base = baseSha ? await readProjectAtRevision(root, relPath, baseSha) : null // null is fine — added on both sides.
  const ours = await readProjectAtRevision(root, relPath, 'HEAD')
  const theirs = await readProjectAtRevision(root, relPath, ref)
  if (ours === null || theirs === null) {
    return {
      kind: 'error',
      message: `The project file does not exist at ${ours === null ? 'HEAD' : ref}. Merge this by hand with git.`,
    }
  }

  const merge = await runGit(['merge', '--no-commit', '--no-ff', ref], root)
  // A merge that fails to *start* (unrelated histories, a hook refusing) leaves
  // no MERGE_HEAD; `merge --abort` would then itself fail with "There is no
  // merge to abort". Checking MERGE_HEAD is what keeps the contract above true.
  if (!(await runGit(['rev-parse', '--verify', '-q', 'MERGE_HEAD'], root)).ok) {
    return { kind: 'error', message: gitErrorText(merge) }
  }

  const dir = annotationsRelDir(relPath)
  const st2 = await runGit(['status', '--porcelain=v1', '-z'], root)
  const unmerged = parsePorcelain(st2.stdout)
    .filter((c) => c.unmerged)
    .map((c) => c.path)
  // `relPath` and this project's own family of files under `dir` are ours to
  // reconcile (git's own per-file merge may have already resolved some of
  // them cleanly, or left others with conflict markers — `mergeProjects`
  // re-derives the whole result from base/ours/theirs regardless, the same
  // way it already did for the single project file this replaces).
  //
  // "Anything under `dir`" used to be the whole test — wrong whenever a
  // sibling project shares the folder: its file would be waived through this
  // check instead of aborting the merge, git's own line-based merge would
  // leave raw conflict-marker text inside it, and that would then get
  // committed. `matchesOwn` is the union of `ours`' and `theirs`' own paper
  // lists — union, not just `ours`, because a paper the remote side added is
  // legitimately this project's family too even though it's absent from
  // `ours`, and using only `ours` would misclassify an ordinary new-paper
  // pull as `conflict-elsewhere`.
  let matchesOwn: (rel: string) => boolean
  try {
    const matchesOurs = ownAnnotationPathMatcher(JSON.parse(ours))
    const matchesTheirs = ownAnnotationPathMatcher(JSON.parse(theirs))
    matchesOwn = (rel) => matchesOurs(rel) || matchesTheirs(rel)
  } catch {
    // Can't tell what's ours — fail toward the existing conflict-elsewhere
    // abort rather than guessing something unreadable is safe to merge over.
    matchesOwn = () => false
  }
  const others = unmerged.filter((p) => p !== relPath && !(p.startsWith(`${dir}/`) && matchesOwn(p.slice(dir.length + 1))))
  if (others.length > 0) {
    // SaiLoR knows how to merge an annotation JSON. It does not know how to
    // merge a PDF or a .gitignore — abort cleanly and hand it back rather
    // than half-doing it.
    await runGit(['merge', '--abort'], root)
    return { kind: 'conflict-elsewhere', paths: others }
  }

  return { kind: 'merge', ref, base, ours, theirs }
}

/** The pull classification: resolve the upstream, fetch, then merge it in.
 *  Inherits `beginMergeInto`'s contract. */
ipcMain.handle('git:pullBegin', async (_e, root: string, relPath: string) => {
  assertRelPath(relPath)

  const dirty = await mergeBlockingDirtyPaths(root)
  if (dirty.length > 0) return { kind: 'dirty', paths: dirty }

  const up = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root)
  if (!up.ok) {
    const branchRun = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], root)
    return { kind: 'no-upstream', branch: branchRun.ok ? gitOut(branchRun) || null : null }
  }
  const ref = gitOut(up)

  const fetch = await runGit(['fetch'], root, GIT_NETWORK_TIMEOUT_MS)
  if (!fetch.ok) return { kind: 'error', message: gitErrorText(fetch) }

  return beginMergeInto(root, relPath, ref)
})

/**
 * Merge an arbitrary branch — local or remote-tracking — into the current one.
 * Deliberately the *pull* shape and not the branch-switch shape: merging does
 * not move HEAD, so there is no stash/checkout dance to undo, and
 * `git:pullFinish`/`git:pullAbort` finish and abort this identically.
 */
ipcMain.handle('git:mergeBegin', async (_e, root: string, relPath: string, ref: string) => {
  assertRelPath(relPath)
  assertRef(ref)

  const dirty = await mergeBlockingDirtyPaths(root)
  if (dirty.length > 0) return { kind: 'dirty', paths: dirty }

  // A remote-tracking ref is only as fresh as the last fetch, and the branch
  // list the reviewer picked from may have been read long before. Refresh it
  // so "merge origin/side" means what it says. A local branch needs nothing.
  if (ref.startsWith('refs/remotes/') || (await isRemoteTrackingRef(root, ref))) {
    const fetch = await runGit(['fetch'], root, GIT_NETWORK_TIMEOUT_MS)
    if (!fetch.ok) return { kind: 'error', message: gitErrorText(fetch) }
  }

  // `^{commit}` both resolves the ref and rejects anything that is not one —
  // the existence half of the guard `assertRef` cannot do from the string.
  if (!(await runGit(['rev-parse', '--verify', '-q', `${ref}^{commit}`], root)).ok) {
    return { kind: 'error', message: `There is no branch named ${ref}.` }
  }

  return beginMergeInto(root, relPath, ref)
})

/** True when `ref` names something under `refs/remotes/` — checked against git
 *  rather than guessed from the "origin/" prefix, since a local branch may
 *  legitimately be called that. */
async function isRemoteTrackingRef(root: string, ref: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '--symbolic-full-name', '--verify', '-q', ref], root)
  return r.ok && gitOut(r).startsWith('refs/remotes/')
}

/**
 * Records the merge commit for a pull or an explicit branch merge alike —
 * both leave `MERGE_HEAD` set, which is all this needs.
 *
 * Wrapped in `try`/`catch`, unlike a plain sequence of awaits: a throw here
 * (`assertInsideRoot`'s refusal, a symlinked annotation path, `ENOSPC`/
 * `EACCES`) would otherwise reject the IPC call, and `doFinish` in
 * `gitStore.ts` has no catch of its own around this — its careful "leave
 * `panel.merge` in place so Cancel merge stays reachable" recovery only runs
 * for an `{ok: false}` result, not a rejection. An uncaught one there throws
 * out of `doFinish` silently: `applyMergeStart` already moved `phase` back to
 * `'idle'`, so the panel looks ordinary while the repo is still mid-merge
 * with some annotation files rewritten and others not.
 */
ipcMain.handle(
  'git:pullFinish',
  async (
    _e,
    root: string,
    relPath: string,
    working: { metaText: string; files: Array<{ relPath: string; text: string | null }> },
  ) => {
    try {
      assertRelPath(relPath)
      const fullPath = path.join(root, relPath)
      await assertInsideRoot(root, fullPath)
      await writeProjectFiles(fullPath, working.metaText, working.files)
      const add = await runGit(['add', '--', relPath, annotationsRelDir(relPath)], root)
      if (!add.ok) return add
      // `git commit` after a merge with MERGE_HEAD set records both parents and
      // allows an empty tree change, which is why the merge commit is made this
      // way rather than with `commit-tree` or `merge -m`. `--no-edit` takes git's
      // own prepared MERGE_MSG; GIT_EDITOR=true above is the backstop.
      return await runGit(['commit', '--no-edit'], root)
    } catch (err) {
      return { ok: false, code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  },
)

/** Undoes whichever of `git:pullBegin`/`git:mergeBegin` is in flight — a merge
 *  is a merge regardless of which ref started it. */
ipcMain.handle('git:pullAbort', async (_e, root: string) => {
  return runGit(['merge', '--abort'], root)
})

/**
 * Local branches and remote-tracking ones, in one list. The switcher takes the
 * locals (checking out a remote-tracking ref would detach HEAD); the merge
 * picker takes both. `for-each-ref` rather than `git branch -a` because it
 * gives the full refname, which is what says which namespace a row came from
 * without having to parse a "remotes/" prefix back off the short name.
 */
ipcMain.handle('git:branches', async (_e, root: string) => {
  const r = await runGit(
    ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(HEAD)', 'refs/heads', 'refs/remotes'],
    root,
  )
  if (!r.ok) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    // `refs/remotes/origin/HEAD` is a symref pointing at the remote's default
    // branch, not a branch of its own — merging it would silently mean
    // "origin/main" under another name. Matched on the *full* refname: its
    // short form is bare "origin", which no name-based test would catch.
    .filter(([refname]) => !refname.endsWith('/HEAD'))
    .map(([refname, name, head]) => ({
      name,
      current: head === '*',
      remote: refname.startsWith('refs/remotes/'),
    }))
})

/**
 * Creates `name` pointing at the current `HEAD`, without switching to it —
 * the renderer always follows this with the ordinary switch flow
 * (`requestSwitchBranch`), which is what actually checks it out and, since
 * a freshly created branch shares the exact commit it was cut from, can
 * never itself produce a conflict when carrying uncommitted changes across.
 * `--` disambiguates the name from a path the same way `git:checkout` does;
 * unlike the branch list (always names git itself produced), this one is
 * reviewer-typed, so git's own `check-ref-format` rules are what actually
 * reject an invalid name — surfaced via the run's own stderr.
 */
ipcMain.handle('git:branchCreate', async (_e, root: string, name: string) => {
  return runGit(['branch', '--', name], root)
})

/**
 * `-d`, never `-D`: git itself refuses when `branch` isn't fully merged into
 * the current one, and that refusal — surfaced via the returned `GitRun`'s
 * `ok: false` and `gitErrorText` — is the answer this app wants, not a force
 * option to override it. `branch` always comes from `git:branches`' own
 * output (the picker only ever offers real names), the same trust model
 * `git:branchCreate`/`git:checkout` already use — hence just `--`, no
 * `refProblem`-style validation.
 */
ipcMain.handle('git:branchDelete', async (_e, root: string, branch: string) => {
  return runGit(['branch', '-d', '--', branch], root)
})

/** A plain checkout with nothing local to carry — only reached after
 *  `beginBranchSwitch` confirmed there is nothing project-related to lose
 *  (`'no-changes'`), or for a repo with no open project at all. The trailing
 *  `--` is the standard git idiom that disambiguates a branch name from a
 *  path, belt-and-suspenders alongside the branch list itself already only
 *  ever offering names `git branch` produced. */
ipcMain.handle('git:checkout', async (_e, root: string, branch: string) => {
  assertRoot(root)
  assertRef(branch)
  return runGit(['checkout', branch, '--'], root)
})

/**
 * Checks whether switching to `branch` is safe given the project's
 * uncommitted state, and — only in the `'merge'` case — actually performs
 * the switch: stashes the project's own dirty files, checks out `branch`,
 * and reads the three revisions `mergeProjects` needs. The stash/checkout
 * happen here (not left for `finishBranchSwitch`) because captured
 * base/ours/theirs text and the mutation must be atomic with each other —
 * nothing may change the working tree between "read what's there" and
 * "stash it" without invalidating `ours`.
 *
 * Refuses (touching nothing) whenever anything *outside* the project's own
 * files is also dirty: SaiLoR knows how to carry the project's uncommitted
 * changes across a switch (the same field-level merge the pull flow uses),
 * but has no honest way to carry an arbitrary file's local edit across two
 * branches that might disagree about it — the same limitation, and the same
 * refusal, `beginPull`'s `'conflict-elsewhere'` already has.
 *
 * "The project's own files" used to mean *anything* under `annotations/` —
 * wrong whenever a sibling project's file sits in the same folder (SaiLoR's
 * own "Start full-text screening" flow creates exactly this layout on
 * purpose). `matchesOwn` narrows that to the paper-id/filename shapes this
 * project's own family would actually write (`ownAnnotationPathMatcher`), so
 * a sibling's uncommitted work is treated as "other files dirty" and refused
 * — same as any file this app doesn't know how to carry — instead of being
 * silently stashed alongside this project's own and left behind if the
 * eventual `finishBranchSwitch` never writes it back.
 */
ipcMain.handle('git:branchSwitchBegin', async (_e, root: string, relPath: string, branch: string) => {
  assertRoot(root)
  assertRelPath(relPath)
  assertRef(branch)
  const dir = annotationsRelDir(relPath)
  // Read the *working tree's* current project.json, not HEAD — an
  // uncommitted new paper must still count as this project's own. A
  // directory that collapses to one opaque `?? annotations/` porcelain
  // record (nothing under it tracked anywhere yet) can't be resolved to
  // individual files at all; `matchesOwn` returning `false` for everything
  // in that case is what makes it fail toward a clean `other-files-dirty`
  // refusal instead of guessing that an unreadable blob is ours.
  let matchesOwn: (rel: string) => boolean
  try {
    matchesOwn = ownAnnotationPathMatcher(JSON.parse(await readProjectText(path.join(root, relPath))))
  } catch {
    matchesOwn = () => false
  }
  const inProjectScope = (p: string) =>
    p === relPath || (p.startsWith(`${dir}/`) && matchesOwn(p.slice(dir.length + 1)))

  const st = await runGit(['status', '--porcelain=v1', '-z'], root)
  const changes = parsePorcelain(st.stdout)
  const otherPaths = changes.filter((c) => !inProjectScope(c.path)).map((c) => c.path)
  if (otherPaths.length > 0) return { kind: 'other-files-dirty', paths: otherPaths }
  if (!changes.some((c) => inProjectScope(c.path))) return { kind: 'no-changes' }

  const sourceBranchRun = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], root)
  const sourceBranch = sourceBranchRun.ok ? gitOut(sourceBranchRun) : ''
  if (!sourceBranch) return { kind: 'error', message: 'Cannot switch branches from a detached HEAD.' }

  const oldHead = gitOut(await runGit(['rev-parse', 'HEAD'], root))
  const base = await readProjectAtRevision(root, relPath, oldHead)
  let ours: string
  try {
    ours = await readProjectText(path.join(root, relPath))
  } catch (err) {
    return {
      kind: 'error',
      message: `Could not read the project's current state: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const theirs = await readProjectAtRevision(root, relPath, branch)
  if (theirs === null) {
    return { kind: 'error', message: `The project file does not exist on branch "${branch}".` }
  }

  const stash = await runGit(
    ['stash', 'push', '-u', '-m', 'sailor: switching branch', '--', relPath, dir],
    root,
  )
  if (!stash.ok) return { kind: 'error', message: gitErrorText(stash) }

  const checkout = await runGit(['checkout', branch, '--'], root)
  if (!checkout.ok) {
    // Put things back exactly as they were — nothing about this attempt
    // should be visible if the checkout itself failed.
    await runGit(['stash', 'pop'], root)
    return { kind: 'error', message: gitErrorText(checkout) }
  }

  return { kind: 'merge', sourceBranch, base, ours, theirs }
})

/**
 * Writes the merge-resolved project onto the just-checked-out target
 * branch's working tree, then drops the stash `beginBranchSwitch` created —
 * its content is now fully folded into what was just written, so leaving it
 * around would just be a stray entry the reviewer has to notice and clean
 * up themselves.
 *
 * Wrapped in `try`/`catch` for the same reason `git:pullFinish` is: a throw
 * here would reject past `doFinish`'s own recovery in `gitStore.ts`, leaving
 * the checkout already moved, the stash still present, and the panel showing
 * no error — see that handler's doc comment for the full reasoning.
 */
ipcMain.handle(
  'git:branchSwitchFinish',
  async (
    _e,
    root: string,
    relPath: string,
    resolved: { metaText: string; files: Array<{ relPath: string; text: string | null }> },
  ) => {
    try {
      assertRelPath(relPath)
      const fullPath = path.join(root, relPath)
      await assertInsideRoot(root, fullPath)
      await writeProjectFiles(fullPath, resolved.metaText, resolved.files)
      return await runGit(['stash', 'drop'], root)
    } catch (err) {
      return { ok: false, code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  },
)

/** Reverses an already-completed `beginBranchSwitch`: checks back out to
 *  `sourceBranch` and restores the stashed changes. Unlike `git:pullAbort`
 *  (which aborts an in-progress `git merge` that never left a stable state),
 *  the checkout here already succeeded by the time a reviewer can cancel —
 *  this undoes it rather than merely stopping something in flight. */
ipcMain.handle('git:branchSwitchAbort', async (_e, root: string, sourceBranch: string) => {
  assertRoot(root)
  assertRef(sourceBranch)
  const checkout = await runGit(['checkout', sourceBranch, '--'], root)
  if (!checkout.ok) return checkout
  return runGit(['stash', 'pop'], root)
})

// Remember that a quit is in progress so the close guard can, after the user
// confirms, resume quitting (rather than merely closing the window on macOS).
app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
