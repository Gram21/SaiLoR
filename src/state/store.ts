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
  type InstanceNode,
} from '../model/annotations'
import type { ResolvedDef } from '../model/schema'
import { validateProject, type ValidationIssue } from '../model/validate'
import { formatPath, resolvePath } from '../llm/paths'
import { isUnanswered } from '../llm/fields'
import type { Suggestion } from '../llm/types'
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

/**
 * Key of one field instance's "the AI wrote this" mark. Scoped by paper, because
 * the same canonical path exists on every paper. The path part is `formatPath`'s
 * canonical form, so a mark set from an LLM suggestion and one looked up by the
 * UI meet on the same string.
 */
export function aiMarkKey(paperId: string, canonicalPath: string): string {
  return `${paperId}::${canonicalPath}`
}

/** Canonical path of a field instance as the UI addresses it (container path + leaf). */
export function fieldPath(path: PathSeg[], name: string, index: number): string {
  return formatPath([...path, { name, index }])
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
  /** The project's own title from its JSON; empty when it doesn't set one. */
  projectTitle: string
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
  /** Shown when closing a project with unsaved changes. */
  closePromptOpen: boolean
  /** The running version, injected from package.json at build time. */
  appVersion: string
  /** Set only when a *newer* release exists; null while up to date or unknowable. */
  update: UpdateInfo | null
  /** Undo/redo history of annotation changes (session-only). */
  past: HistoryEntry[]
  future: HistoryEntry[]
  /**
   * Fields the AI filled and the reviewer has not yet looked at, keyed by
   * `aiMarkKey`. Session-only *by construction*: it lives beside the project
   * rather than inside it, so `serializeProject` cannot see it and a mark can
   * never reach the file on disk. A plain record (not a Set) keeps immer happy.
   */
  aiMarks: Record<string, true>
  /**
   * AI-assisted annotation ships in the app but is off by default for every
   * project, regardless of what its `config.ai` says — a project can still
   * *forbid* it (`config.ai: false` always wins), but it can no longer turn it
   * on by itself. It is unlocked only by the hidden gesture wired up in
   * `Toolbar.tsx`, and only for the running session: this is never persisted
   * and never set from anywhere else, so it is back to locked on every reload.
   */
  aiUnlocked: boolean

  openProject: () => Promise<void>
  openRecent: (id: string) => Promise<void>
  /** Drop a project from the recents list. */
  forgetRecent: (id: string) => void
  /** Re-check which recents still exist, marking the rest unavailable. */
  refreshRecents: () => Promise<void>
  /** Close the open project (prompting to save first when dirty). */
  requestCloseProject: () => void
  /** Answer the close prompt. */
  resolveClosePrompt: (choice: 'save' | 'discard' | 'cancel') => Promise<void>
  /** Discard the open project and return to the start screen. */
  closeProject: () => void
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
  /** Write the reviewer-approved AI suggestions into the current paper (one undo step). */
  applyAiSuggestions: (suggestions: Suggestion[], usage: { provider: string; model: string }) => AiApplyResult
  /** The reviewer looked at an AI-filled field — drop its mark. */
  confirmAiMark: (paperId: string, canonicalPath: string) => void
  /** The hidden gesture landed — allow AI use for the rest of this session. */
  unlockAi: () => void
}

/** What `applyAiSuggestions` actually did, for the summary shown to the reviewer. */
export interface AiApplyResult {
  filled: number
  /** Suggestions not written: the field is no longer empty, or the path no longer resolves. */
  skipped: number
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
    projectTitle: '',
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
    closePromptOpen: false,
    appVersion: APP_VERSION,
    update: null,
    past: [],
    future: [],
    aiMarks: {},
    aiUnlocked: false,

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

    forgetRecent: (id) => {
      const recents = getPlatform().forgetRecent(id)
      set((s) => {
        s.recents = recents
      })
    },

    refreshRecents: async () => {
      const platform = getPlatform()
      try {
        const checked = await platform.checkRecents(platform.getRecents())
        set((s) => {
          s.recents = checked
        })
      } catch {
        // Called fire-and-forget (startup, after an editor save). A failure to
        // re-read titles must never surface as an unhandled rejection — the
        // list simply keeps what it had.
      }
    },

    requestCloseProject: () => {
      if (!get().project) return
      // An unsaved project asks first — exactly like quitting the app does.
      if (get().dirty) {
        set((s) => {
          s.closePromptOpen = true
        })
        return
      }
      get().closeProject()
    },

    resolveClosePrompt: async (choice) => {
      if (choice === 'cancel') {
        set((s) => {
          s.closePromptOpen = false
        })
        return
      }
      if (choice === 'save' && !(await get().save())) {
        // The save failed or was cancelled — keep the project open.
        set((s) => {
          s.closePromptOpen = false
        })
        return
      }
      set((s) => {
        s.closePromptOpen = false
      })
      get().closeProject()
    },

    closeProject: () => {
      lastFieldKey = null
      set((s) => {
        s.project = null
        s.currentPaperId = null
        s.saveHandle = null
        s.projectName = ''
        s.projectTitle = ''
        s.dirty = false
        s.pdfSelection = ''
        s.past = []
        s.future = []
        s.aiMarks = {}
        s.validation = null
        s.validationOpen = false
        s.closePromptOpen = false
      })
      void get().refreshRecents()
    },

    openRecent: async (id) => {
      const platform = getPlatform()
      set((s) => {
        s.busy = true
      })
      try {
        const opened = await platform.openRecent(id)
        if (!opened) {
          // The file is gone. Keep the entry — the drive may come back — but
          // mark it unavailable so it greys out instead of vanishing.
          set((s) => {
            s.busy = false
            s.recents = s.recents.map((r) => (r.id === id ? { ...r, available: false } : r))
            s.loadError = {
              message: 'That project could not be opened.',
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
        // The title only becomes known once the JSON is parsed, so the recents
        // entry is enriched here rather than in the adapter's open path.
        if (handle) getPlatform().rememberProject(handle, name, project.title)
        set((s) => {
          s.project = project
          s.saveHandle = handle
          s.projectName = name
          s.projectTitle = project.title ?? ''
          s.recents = getPlatform().getRecents()
          s.currentPaperId = project.papers[0]?.id ?? null
          s.dirty = false
          s.loadError = null
          s.busy = false
          s.pdfSelection = ''
          s.past = []
          s.future = []
          // Marks belong to the papers of the project that is going away.
          s.aiMarks = {}
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

    applyAiSuggestions: (suggestions, usage) => {
      const prev = get()
      if (!prev.project) return { filled: 0, skipped: suggestions.length }
      const schema = prev.project.schema
      const paperNow = currentPaper(prev)
      if (!paperNow) return { filled: 0, skipped: suggestions.length }

      // Decide what to write *before* touching anything, so a run that turns out to
      // change nothing leaves no empty entry on the undo stack. A suggestion is
      // dropped if its path no longer resolves, or if the field has since been
      // answered — the reviewer's own work is never overwritten.
      const accepted = suggestions.flatMap((sug) => {
        const at = resolvePath(schema, sug.path)
        if (!at) return []
        const current = peekValue(paperNow.annotations, at.path, at.name, at.index)
        if (!isUnanswered(at.def, current)) return []
        return [{ at, value: sug.value }]
      })
      if (accepted.length === 0) return { filled: 0, skipped: suggestions.length }

      // The whole fill is one undo step: snapshot once, then mutate. Reset the
      // coalescing key, or the reviewer's next keystroke would be folded into it.
      lastFieldKey = null
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      const paperId = paperNow.id
      let filled = 0
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        pushPast(s, snap)
        for (const { at, value } of accepted) {
          // The model may address an entry of a repeatable node that does not exist
          // yet — that is how it records a further Finding. Create the instances it
          // named, along the whole path.
          let level: ResolvedDef[] = s.project!.schema
          let tree: AnnotationValueTree | null = paper.annotations
          for (const seg of at.path) {
            const step = ensureInstance(level, tree, seg.name, seg.index)
            if (!step) {
              tree = null
              break
            }
            if (!step.inst.children) step.inst.children = {}
            tree = step.inst.children
            level = step.def.children
          }
          if (!tree) continue
          const leaf = ensureInstance(level, tree, at.name, at.index)
          if (!leaf) continue
          leaf.inst.value = value
          // Mark only what was actually written: a skipped suggestion left the
          // field as the reviewer had it, and must not be flagged as the AI's.
          s.aiMarks[aiMarkKey(paperId, at.canonical)] = true
          filled++
        }
        // A disclosure record, not a UI hint: only added when this pass actually
        // changed something, and — unlike the mark above — it is meant to reach
        // the saved file and outlive this session. See `AiUsageRecord`.
        if (filled > 0) {
          paper.aiUsage.push({
            provider: usage.provider,
            model: usage.model,
            appliedAt: new Date().toISOString(),
          })
        }
        s.dirty = true
      })
      return { filled, skipped: suggestions.length - filled }
    },

    confirmAiMark: (paperId, canonicalPath) => {
      const key = aiMarkKey(paperId, canonicalPath)
      // Focusing a field the AI never touched is the common case — don't churn
      // the store (and re-render every field) for a mark that isn't there.
      if (!get().aiMarks[key]) return
      set((s) => {
        delete s.aiMarks[key]
      })
    },

    unlockAi: () => {
      if (get().aiUnlocked) return // already unlocked — no re-render needed
      set((s) => {
        s.aiUnlocked = true
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
        // The values a mark points at may have just been taken away (undoing an
        // AI run empties exactly those fields), and a blue border on an empty
        // field is a lie. Marks are not part of the history, so the only honest
        // and simple answer is to drop them all — the reviewer keeps the values,
        // just not the "look here" hints.
        s.aiMarks = {}
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
        // Symmetric with undo: the history restores values, not marks, and a redo
        // cannot know which of the restored values came from the model.
        s.aiMarks = {}
      })
    },
  })),
)

/**
 * Read a field's current value without creating anything. A missing instance
 * reads as `undefined` — which is "unanswered", and correctly so: it is a slot
 * the model asked to add.
 */
function peekValue(
  root: AnnotationValueTree,
  path: PathSeg[],
  name: string,
  index: number,
): FieldValue | undefined {
  let tree: AnnotationValueTree | undefined = root
  for (const seg of path) {
    tree = tree?.[seg.name]?.[seg.index]?.children
    if (!tree) return undefined
  }
  return tree[name]?.[index]?.value
}

/**
 * Find (or create) instance `index` of `name` in `tree`, padding the list with
 * empty instances as needed. Returns null when the name is unknown at this level
 * or the index would exceed the node's `max`.
 */
function ensureInstance(
  defs: ResolvedDef[],
  tree: AnnotationValueTree,
  name: string,
  index: number,
): { inst: InstanceNode; def: ResolvedDef } | null {
  const def = defs.find((d) => d.name === name)
  if (!def) return null
  if (def.max !== null && index >= def.max) return null

  // The JSON is hand-editable, so this key may hold something that is not a list
  // of instances at all. Replace it rather than crash — the AI is filling an empty
  // field, and a malformed node has no answer to preserve.
  let list = tree[name]
  if (!Array.isArray(list)) {
    list = []
    tree[name] = list
  }
  while (list.length <= index) list.push(makeInstance(def))
  return { inst: list[index], def }
}

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

/**
 * Whether the AI filled this field instance, plus the callback that confirms it.
 * The pair is what every marked control needs, and keeping the key derivation in
 * one place stops the UI and `applyAiSuggestions` from drifting apart.
 */
export function useAiMark(path: PathSeg[], name: string, index: number): [boolean, () => void] {
  const canonical = fieldPath(path, name, index)
  const marked = useStore(
    (s) => s.currentPaperId !== null && s.aiMarks[aiMarkKey(s.currentPaperId, canonical)] === true,
  )
  const confirm = () => {
    const paperId = useStore.getState().currentPaperId
    if (paperId) useStore.getState().confirmAiMark(paperId, canonical)
  }
  return [marked, confirm]
}
