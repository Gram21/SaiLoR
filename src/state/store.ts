import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  loadProject,
  serializeProject,
  ProjectLoadError,
  type Project,
} from '../model/project'
import {
  makeInstance,
  type AnnotationValueTree,
  type FieldValue,
} from '../model/annotations'
import type { ResolvedDef } from '../model/schema'
import { validateProject, type ValidationIssue } from '../model/validate'
import {
  fetchLatestRelease,
  updateFrom,
  CHECK_INTERVAL_MS,
  type UpdateInfo,
} from '../model/version'
import { getPlatform, type SaveHandle } from '../platform'
import { BrowserAdapter } from '../platform/browser'
import type { RecentEntry } from '../platform/recents'
import {
  type Theme,
  loadTheme,
  loadFontScale,
  applyTheme,
  applyFontScale,
  clampFont,
  FONT_STEP,
} from './settings'

/** Injected from package.json by vite.config.ts; falls back for non-Vite runners (tests). */
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'

const UPDATE_CACHE_KEY = 'slr.updateCheck'

interface UpdateCache {
  checkedAt: number
  release: UpdateInfo | null
}

/** The cached release lookup, or null when it is missing or stale. */
function readUpdateCache(): UpdateCache | null {
  try {
    const raw = localStorage.getItem(UPDATE_CACHE_KEY)
    if (!raw) return null
    const cache = JSON.parse(raw) as UpdateCache
    if (typeof cache.checkedAt !== 'number') return null
    if (Date.now() - cache.checkedAt > CHECK_INTERVAL_MS) return null
    return cache
  } catch {
    return null
  }
}

/** Remember the lookup — including a `null` result, so a private repo or an
 *  offline launch doesn't retry on every startup. */
function writeUpdateCache(release: UpdateInfo | null): void {
  try {
    localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify({ checkedAt: Date.now(), release }))
  } catch {
    /* localStorage unavailable — the check simply runs again next time. */
  }
}

/** A step into the annotation tree: pick instance `index` of node `name`. */
export interface PathSeg {
  name: string
  index: number
}

export interface LoadError {
  message: string
  details: string[]
}

/**
 * One undo/redo snapshot. Because the store uses immer, each `project` is an
 * immutable value with structural sharing, so keeping references to previous
 * projects is cheap (only the changed annotation path differs between them).
 */
interface HistoryEntry {
  project: Project
  paperId: string | null
}

const HISTORY_LIMIT = 100

// PDF zoom bounds (multiplier applied to the fit-to-width base size).
export const PDF_ZOOM_MIN = 0.4
export const PDF_ZOOM_MAX = 3
const PDF_ZOOM_STEP = 0.2
const roundZoom = (z: number) => Math.round(z * 100) / 100

/**
 * Tracks the last edited field so consecutive edits to the *same* field (e.g.
 * typing character by character) collapse into a single undo step instead of
 * one per keystroke. Reset by any other action.
 */
let lastFieldKey: string | null = null

interface AppState {
  project: Project | null
  currentPaperId: string | null
  saveHandle: SaveHandle | null
  projectName: string
  dirty: boolean
  loadError: LoadError | null
  busy: boolean
  sidebarCollapsed: boolean
  /** Latest text selected inside the PDF viewer (for "grab from PDF"). */
  pdfSelection: string
  theme: Theme
  fontScale: number
  /** Zoom multiplier for the PDF page (session-only). */
  pdfZoom: number
  recents: RecentEntry[]
  helpOpen: boolean
  /** Result of the last validation run; null until the user asks for one. */
  validation: ValidationIssue[] | null
  validationOpen: boolean
  /** The running version, injected from package.json at build time. */
  appVersion: string
  /** Set only when a *newer* release exists; null while up to date or unknowable. */
  update: UpdateInfo | null
  /** Undo/redo history of annotation changes (session-only). */
  past: HistoryEntry[]
  future: HistoryEntry[]

  openProject: () => Promise<void>
  openRecent: (id: string) => Promise<void>
  loadFromUrl: (url: string) => Promise<void>
  loadFromText: (text: string, handle: SaveHandle | null, name: string) => void
  save: () => Promise<boolean>
  saveAs: () => Promise<boolean>
  selectPaper: (id: string) => void
  toggleSidebar: () => void
  setPdfSelection: (text: string) => void
  clearError: () => void
  toggleTheme: () => void
  setTheme: (theme: Theme) => void
  increaseFont: () => void
  decreaseFont: () => void
  resetFont: () => void
  zoomInPdf: () => void
  zoomOutPdf: () => void
  resetPdfZoom: () => void
  setHelpOpen: (open: boolean) => void
  /** Check every paper's annotations against the schema and show the result. */
  runValidation: () => void
  setValidationOpen: (open: boolean) => void
  /** Look for a newer release (cached; silent when it can't be determined). */
  checkForUpdate: () => Promise<void>

  setFieldValue: (path: PathSeg[], name: string, index: number, value: FieldValue) => void
  addInstance: (path: PathSeg[], def: ResolvedDef) => void
  removeInstance: (path: PathSeg[], name: string, index: number) => void
  undo: () => void
  redo: () => void
}

/** Walk from a paper's annotation root to the container tree addressed by `path`. */
function containerAt(root: AnnotationValueTree, path: PathSeg[]): AnnotationValueTree {
  let tree = root
  for (const seg of path) {
    const inst = tree[seg.name]?.[seg.index]
    if (!inst || !inst.children) {
      throw new Error(`Invalid annotation path at "${seg.name}[${seg.index}]"`)
    }
    tree = inst.children
  }
  return tree
}

export const useStore = create<AppState>()(
  immer((set, get) => ({
    project: null,
    currentPaperId: null,
    saveHandle: null,
    projectName: '',
    dirty: false,
    loadError: null,
    busy: false,
    sidebarCollapsed: false,
    pdfSelection: '',
    theme: loadTheme(),
    fontScale: loadFontScale(),
    pdfZoom: 1,
    recents: getPlatform().getRecents(),
    helpOpen: false,
    validation: null,
    validationOpen: false,
    appVersion: APP_VERSION,
    update: null,
    past: [],
    future: [],

    openProject: async () => {
      const platform = getPlatform()
      set((s) => {
        s.busy = true
      })
      try {
        const opened = await platform.openProject()
        if (!opened) {
          set((s) => {
            s.busy = false
          })
          return
        }
        get().loadFromText(opened.text, opened.handle, opened.name)
        set((s) => {
          s.recents = platform.getRecents()
        })
      } catch (err) {
        set((s) => {
          s.busy = false
          s.loadError = { message: 'Failed to open the project.', details: [String(err)] }
        })
      }
    },

    openRecent: async (id) => {
      const platform = getPlatform()
      set((s) => {
        s.busy = true
      })
      try {
        const opened = await platform.openRecent(id)
        if (!opened) {
          // Entry was stale and has been pruned from the list.
          set((s) => {
            s.busy = false
            s.recents = platform.getRecents()
            s.loadError = {
              message: 'That recent file could not be opened.',
              details: ['It may have been moved, renamed, or deleted.'],
            }
          })
          return
        }
        get().loadFromText(opened.text, opened.handle, opened.name)
        set((s) => {
          s.recents = platform.getRecents()
        })
      } catch (err) {
        set((s) => {
          s.busy = false
          s.loadError = { message: 'Failed to open the recent file.', details: [String(err)] }
        })
      }
    },

    loadFromUrl: async (url) => {
      set((s) => {
        s.busy = true
      })
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
        const text = await res.text()
        const platform = getPlatform()
        // In the browser, remember the base URL so sibling PDFs resolve.
        if (platform instanceof BrowserAdapter) platform.setServerBase(url)
        const name = url.split('/').pop() || 'project.json'
        // Loaded from a server: no writable handle (Save falls back to download).
        get().loadFromText(text, null, name)
      } catch (err) {
        set((s) => {
          s.busy = false
          s.loadError = { message: 'Failed to load the project from URL.', details: [String(err)] }
        })
      }
    },

    loadFromText: (text, handle, name) => {
      try {
        const project = loadProject(text)
        set((s) => {
          s.project = project
          s.saveHandle = handle
          s.projectName = name
          s.currentPaperId = project.papers[0]?.id ?? null
          s.dirty = false
          s.loadError = null
          s.busy = false
          s.pdfSelection = ''
          s.past = []
          s.future = []
          s.validation = null
          s.validationOpen = false
        })
        lastFieldKey = null
      } catch (err) {
        const le: LoadError =
          err instanceof ProjectLoadError
            ? { message: err.message, details: err.details }
            : { message: 'Failed to load the project.', details: [String(err)] }
        set((s) => {
          s.loadError = le
          s.busy = false
        })
      }
    },

    save: async () => {
      const { project, saveHandle } = get()
      if (!project) return false
      if (!saveHandle) return get().saveAs()
      const platform = getPlatform()
      set((s) => {
        s.busy = true
      })
      try {
        const text = serializeProject(project)
        const handle = await platform.saveProject(text, saveHandle)
        set((s) => {
          s.saveHandle = handle
          s.dirty = false
          s.busy = false
        })
        return true
      } catch (err) {
        set((s) => {
          s.busy = false
          s.loadError = { message: 'Failed to save.', details: [String(err)] }
        })
        return false
      }
    },

    saveAs: async () => {
      const { project, projectName, saveHandle } = get()
      if (!project) return false
      const platform = getPlatform()
      set((s) => {
        s.busy = true
      })
      try {
        // Pick the destination *before* serializing: a paper's `pdf` is stored
        // relative to the project file, so writing the old paths to a new
        // location would leave every PDF pointing at nothing.
        const suggested = projectName || 'project.json'
        const location = await platform.pickProjectLocation(suggested)
        if (!location) {
          set((s) => {
            s.busy = false
          })
          return false
        }

        let toWrite = project
        if (saveHandle) {
          const rebased = await platform.rebasePdfPaths(
            project.papers.map((p) => p.pdf),
            saveHandle,
            location.handle,
          )
          toWrite = {
            ...project,
            papers: project.papers.map((p, i) => ({ ...p, pdf: rebased[i] ?? p.pdf })),
          }
        }

        const text = serializeProject(toWrite)
        const handle = await platform.saveProject(text, location.handle)
        set((s) => {
          s.project = toWrite
          s.saveHandle = handle
          s.projectName = location.name
          s.dirty = false
          s.busy = false
          s.recents = platform.getRecents()
        })
        return true
      } catch (err) {
        set((s) => {
          s.busy = false
          s.loadError = { message: 'Failed to save.', details: [String(err)] }
        })
        return false
      }
    },

    selectPaper: (id) => {
      lastFieldKey = null
      set((s) => {
        s.currentPaperId = id
        s.pdfSelection = ''
      })
    },

    toggleSidebar: () =>
      set((s) => {
        s.sidebarCollapsed = !s.sidebarCollapsed
      }),

    setPdfSelection: (text) =>
      set((s) => {
        s.pdfSelection = text
      }),

    clearError: () =>
      set((s) => {
        s.loadError = null
      }),

    setTheme: (theme) => {
      applyTheme(theme)
      set((s) => {
        s.theme = theme
      })
    },

    toggleTheme: () => {
      const next: Theme = get().theme === 'dark' ? 'light' : 'dark'
      get().setTheme(next)
    },

    increaseFont: () => {
      const next = clampFont(get().fontScale + FONT_STEP)
      applyFontScale(next)
      set((s) => {
        s.fontScale = next
      })
    },

    decreaseFont: () => {
      const next = clampFont(get().fontScale - FONT_STEP)
      applyFontScale(next)
      set((s) => {
        s.fontScale = next
      })
    },

    resetFont: () => {
      applyFontScale(1)
      set((s) => {
        s.fontScale = 1
      })
    },

    zoomInPdf: () =>
      set((s) => {
        s.pdfZoom = Math.min(PDF_ZOOM_MAX, roundZoom(s.pdfZoom + PDF_ZOOM_STEP))
      }),

    zoomOutPdf: () =>
      set((s) => {
        s.pdfZoom = Math.max(PDF_ZOOM_MIN, roundZoom(s.pdfZoom - PDF_ZOOM_STEP))
      }),

    resetPdfZoom: () =>
      set((s) => {
        s.pdfZoom = 1
      }),

    setHelpOpen: (open) =>
      set((s) => {
        s.helpOpen = open
      }),

    runValidation: () => {
      const project = get().project
      if (!project) return
      const issues = validateProject(project)
      set((s) => {
        s.validation = issues
        s.validationOpen = true
      })
    },

    setValidationOpen: (open) =>
      set((s) => {
        s.validationOpen = open
      }),

    checkForUpdate: async () => {
      const cached = readUpdateCache()
      // GitHub allows 60 unauthenticated calls an hour per IP, so a daily check
      // is plenty — a fresh cache answers without touching the network.
      if (cached) {
        set((s) => {
          s.update = updateFrom(APP_VERSION, cached.release)
        })
        return
      }
      const release = await fetchLatestRelease(getPlatform().getOsInfo())
      writeUpdateCache(release)
      set((s) => {
        s.update = updateFrom(APP_VERSION, release)
      })
    },

    setFieldValue: (path, name, index, value) => {
      const prev = get()
      if (!prev.project) return
      // Collapse consecutive edits of the same field into one undo step.
      const key = `${JSON.stringify(path)}|${name}|${index}`
      const coalesce = key === lastFieldKey
      lastFieldKey = key
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        const container = containerAt(paper.annotations, path)
        const inst = container[name]?.[index]
        if (!inst) return
        if (!coalesce) pushPast(s, snap)
        inst.value = value
        s.dirty = true
      })
    },

    addInstance: (path, def) => {
      const prev = get()
      if (!prev.project) return
      lastFieldKey = null
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        const container = containerAt(paper.annotations, path)
        const list = container[def.name]
        if (list && (def.max === null || list.length < def.max)) {
          pushPast(s, snap)
          list.push(makeInstance(def))
          s.dirty = true
        }
      })
    },

    removeInstance: (path, name, index) => {
      const prev = get()
      if (!prev.project) return
      lastFieldKey = null
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        const container = containerAt(paper.annotations, path)
        const list = container[name]
        if (list && index >= 0 && index < list.length) {
          pushPast(s, snap)
          list.splice(index, 1)
          s.dirty = true
        }
      })
    },

    undo: () => {
      const st = get()
      if (st.past.length === 0 || !st.project) return
      lastFieldKey = null
      const entry = st.past[st.past.length - 1]
      const current: HistoryEntry = { project: st.project, paperId: st.currentPaperId }
      set((s) => {
        s.past.pop()
        s.future.unshift(current)
        if (s.future.length > HISTORY_LIMIT) s.future.pop()
        s.project = entry.project
        s.currentPaperId = entry.paperId ?? s.currentPaperId
        s.dirty = true
      })
    },

    redo: () => {
      const st = get()
      if (st.future.length === 0 || !st.project) return
      lastFieldKey = null
      const entry = st.future[0]
      const current: HistoryEntry = { project: st.project, paperId: st.currentPaperId }
      set((s) => {
        s.future.shift()
        s.past.push(current)
        if (s.past.length > HISTORY_LIMIT) s.past.shift()
        s.project = entry.project
        s.currentPaperId = entry.paperId ?? s.currentPaperId
        s.dirty = true
      })
    },
  })),
)

/** Push a pre-mutation snapshot onto the undo stack and clear the redo stack. */
function pushPast(s: AppState, snap: HistoryEntry): void {
  s.past.push(snap)
  if (s.past.length > HISTORY_LIMIT) s.past.shift()
  s.future = []
}

function currentPaper(s: AppState) {
  if (!s.project || !s.currentPaperId) return null
  return s.project.papers.find((p) => p.id === s.currentPaperId) ?? null
}

/** Selector: the currently open paper (or null). */
export function selectCurrentPaper(s: AppState) {
  return currentPaper(s)
}
