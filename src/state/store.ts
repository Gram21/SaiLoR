import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  loadProject,
  serializeProject,
  ProjectLoadError,
  type Project,
  type Paper,
} from '../model/project'
import {
  hasAnnotations,
  makeInstance,
  normalizeTree,
  type AnnotationValueTree,
  type FieldValue,
  type InstanceNode,
} from '../model/annotations'
import type { ResolvedDef } from '../model/schema'
import { alignNode } from '../consolidate/align'
import { applyAlignment } from '../consolidate/apply'
import { unanimousFills } from '../consolidate/unanimous'
import { validateProject, type UnannotatedPaper, type ValidationIssue } from '../model/validate'
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
  safeGet,
  safeSet,
  safeRemove,
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
 * the same canonical path exists on every paper — and, for a multi-reviewer
 * project, also scoped by reviewer, because the same path exists once per
 * reviewer's own tree too. `reviewer` is the literal `currentReviewer` value
 * (a numbered reviewer, `"consolidation"`, or `null`); passing `null` (the
 * default, and always correct for a single-reviewer project) reproduces the
 * original two-part key exactly, so nothing about a single-reviewer project's
 * marks changes. The path part is `formatPath`'s canonical form, so a mark set
 * from an LLM suggestion and one looked up by the UI meet on the same string.
 */
export function aiMarkKey(
  paperId: string,
  canonicalPath: string,
  reviewer: string | null = null,
): string {
  return reviewer === null ? `${paperId}::${canonicalPath}` : `${paperId}::${reviewer}::${canonicalPath}`
}

/** Canonical path of a field instance as the UI addresses it (container path + leaf). */
export function fieldPath(path: PathSeg[], name: string, index: number): string {
  return formatPath([...path, { name, index }])
}

/** The reviewer scope a mark key should use right now: `null` for a
 *  single-reviewer project (so its keys stay byte-for-byte the old format),
 *  otherwise the current selection. */
function markReviewerScope(project: Project | null, currentReviewer: string | null): string | null {
  return project && project.reviewers > 1 ? currentReviewer : null
}

const REVIEWER_KEY_PREFIX = 'slr.currentReviewer.'

/**
 * Stable per-project key for persisting the reviewer selection: the save
 * handle's path doubles as one (an absolute Electron path, or the id of a
 * retained FSAPI handle — see `SaveHandle`). A project with neither a path
 * nor a handle at all (server mode, or a browser download-only save) has no
 * way to be told apart from a same-named one on the next launch, so the
 * selection simply isn't persisted for it rather than risk showing up under
 * the wrong project.
 */
function reviewerStorageKey(handle: SaveHandle | null): string | null {
  return handle?.path ? `${REVIEWER_KEY_PREFIX}${handle.path}` : null
}

/** The persisted reviewer selection for this project, or null when there is
 *  none, the project has no stable key, or the stored value no longer fits
 *  (e.g. the reviewer count shrank since it was saved). */
function loadCurrentReviewer(handle: SaveHandle | null, reviewerCount: number): string | null {
  const key = reviewerStorageKey(handle)
  if (!key) return null
  const stored = safeGet(key)
  if (stored === 'consolidation') return stored
  const n = stored === null ? NaN : Number(stored)
  return Number.isInteger(n) && n >= 1 && n <= reviewerCount ? stored : null
}

function saveCurrentReviewer(handle: SaveHandle | null, reviewer: string | null): void {
  const key = reviewerStorageKey(handle)
  if (!key) return
  if (reviewer === null) safeRemove(key)
  else safeSet(key, reviewer)
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
  /** Papers the last run skipped for having no annotations at all — see `validateProject`. */
  validationUnannotated: UnannotatedPaper[] | null
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
   * Fields *the app* filled and the reviewer has not yet looked at, keyed by
   * `aiMarkKey`. Two things produce them, and the border means the same in both
   * cases — "you did not type this; check it": an applied AI suggestion, and
   * Consolidation adopting a value every reviewer gave (`adoptUnanimousValues`).
   * The name predates the second.
   *
   * Session-only *by construction*: it lives beside the project rather than
   * inside it, so `serializeProject` cannot see it and a mark can never reach
   * the file on disk. A plain record (not a Set) keeps immer happy.
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
  /**
   * Which reviewer's work is currently shown/edited: `"1"`.."N" for a numbered
   * reviewer, `"consolidation"` for the built-in role that reconciles them, or
   * `null`. A single-reviewer project (`project.reviewers <= 1`) never leaves
   * `null` — see `currentTree`. A *multi*-reviewer project also starts `null`
   * on load (nobody has picked yet): defaulting to Reviewer 1 would let an
   * edit land unattributed, which is worse than making the reviewer pick
   * first. Selecting is a view switch, not an edit: it is not an undo step and
   * does not set `dirty`, and it is persisted per project (see
   * `saveCurrentReviewer`) so reopening the same file returns to the same seat.
   */
  currentReviewer: string | null
  /** The field a Consolidation-mode "compare" click is showing, or null when
   *  the compare popup is closed. Session-only, like `validationOpen`. */
  consolidationTarget: { path: PathSeg[]; name: string; index: number } | null

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

  /** Switch which reviewer's tree is shown/edited. A view switch, not an edit
   *  — no undo step, no `dirty`. Persisted per project. */
  selectReviewer: (reviewer: string | null) => void
  /** Consolidation clicked "compare" on one field — open the popup for it. */
  openConsolidation: (path: PathSeg[], name: string, index: number) => void
  closeConsolidation: () => void
  /**
   * Match the reviewers' repeated entries under one top-level node, and write
   * the result into the paper: every reviewer's entries reordered so position
   * means the same entry for all of them, and the consolidated tree grown to
   * one entry per match. Returns whether anything actually moved.
   *
   * Driven by `useConsolidationAlignment`, a node at a time. `coalesce` folds
   * this node into the undo entry an earlier node of the same run pushed, so
   * lining a paper up is one undo press rather than one per node.
   */
  alignConsolidationNode: (paperId: string, nodeName: string, coalesce: boolean) => boolean
  /**
   * Fill the consolidated tree's still-unanswered fields with the values every
   * reviewer gave, marking each one the way an AI fill is marked. Returns how
   * many were filled.
   *
   * Runs after `alignConsolidationNode` for the whole paper, and must: it reads
   * every reviewer at the same index, which only means anything once matching
   * has lined their entries up.
   */
  adoptUnanimousValues: (paperId: string, coalesce: boolean) => number
  /** Toggle "the reviewers' answers at this field mean the same thing". */
  toggleFieldEquality: (paperId: string, canonical: string) => void
}

/** What `applyAiSuggestions` actually did, for the summary shown to the reviewer. */
export interface AiApplyResult {
  filled: number
  /** Suggestions not written: the field is no longer empty, or the path no longer resolves. */
  skipped: number
}

/**
 * Route to the tree the app should read/write right now for `paper`, given
 * the project's reviewer count and the current selection:
 *
 *  - single-reviewer (`project.reviewers <= 1`) → `paper.annotations`,
 *    unchanged from single-reviewer behavior before this feature existed.
 *  - Consolidation → `paper.annotations`: the final, shipped result.
 *  - a numbered reviewer → `paper.reviews[N]`.
 *  - multi-reviewer, nobody selected yet → `null`. An unattributed edit must
 *    never land in the shipped consolidated tree, so callers must treat a
 *    `null` result as "nothing to read or write", never silently fall back
 *    to the consolidated tree.
 *
 * `create` controls what happens for a numbered reviewer whose tree doesn't
 * exist on `paper` yet: with `create: true` (only safe inside an immer
 * `set()` producer, since it mutates `paper`) it is lazily initialised and
 * normalized against the schema, and the *live* reference is returned so
 * writes persist. With `create: false` (the default — safe to call from a
 * plain selector or a read-only computation) nothing is mutated and a fresh
 * schema-shaped empty tree is returned instead, purely for display/validation
 * — a reviewer who hasn't written anything yet still sees a well-formed set
 * of empty fields, exactly as `paper.annotations` would on a brand-new paper.
 *
 * Rationale for routing everything through this: if you are Reviewer 2, the
 * app shows and validates *your* work; the Consolidation reviewer sees and
 * validates the final result that actually ships.
 */
export function currentTree(
  project: Project,
  currentReviewer: string | null,
  paper: Paper,
  create = false,
): AnnotationValueTree | null {
  if (project.reviewers <= 1) return paper.annotations
  if (currentReviewer === 'consolidation') return paper.annotations
  if (currentReviewer === null) return null
  const existing = paper.reviews[currentReviewer]
  if (existing) return existing
  if (!create) return normalizeTree(project.schema, undefined)
  paper.reviews[currentReviewer] = normalizeTree(project.schema, undefined)
  return paper.reviews[currentReviewer]
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
    validationUnannotated: null,
    validationOpen: false,
    closePromptOpen: false,
    appVersion: APP_VERSION,
    update: null,
    past: [],
    future: [],
    aiMarks: {},
    aiUnlocked: false,
    currentReviewer: null,
    consolidationTarget: null,

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
        s.validationUnannotated = null
        s.validationOpen = false
        s.closePromptOpen = false
        s.currentReviewer = null
        s.consolidationTarget = null
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
          s.validationUnannotated = null
          s.validationOpen = false
          s.consolidationTarget = null
          // Re-derive rather than carry over: a single-reviewer project never
          // has one, and a multi-reviewer project restores whatever was
          // persisted for *this* file (or null — unselected — if there is
          // none, so the reviewer picks explicitly rather than inheriting
          // whoever the previously open project happened to be showing).
          s.currentReviewer = project.reviewers > 1 ? loadCurrentReviewer(handle, project.reviewers) : null
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
        // Carry the reviewer selection over to the new location's own key, or
        // it would silently look unselected the next time this file is opened.
        saveCurrentReviewer(handle, get().currentReviewer)
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
      const { project, currentReviewer } = get()
      if (!project) return
      // Nothing to validate as "the reviewer" until one is picked — the
      // Validate button is disabled in this state too (see Toolbar.tsx).
      if (project.reviewers > 1 && currentReviewer === null) return
      // Validate the tree the current reviewer is actually responsible for:
      // their own work if they are a numbered reviewer, or the final
      // consolidated result if they are Consolidation — see `currentTree`.
      const papers = project.papers.map((p) => ({
        ...p,
        annotations: currentTree(project, currentReviewer, p) ?? p.annotations,
      }))
      const { issues, unannotated } = validateProject({ ...project, papers })
      set((s) => {
        s.validation = issues
        s.validationUnannotated = unannotated
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
      // Multi-reviewer, nobody picked yet: nothing to attribute this edit to.
      if (prev.project.reviewers > 1 && prev.currentReviewer === null) return
      // Collapse consecutive edits of the same field into one undo step.
      const key = `${JSON.stringify(path)}|${name}|${index}`
      const coalesce = key === lastFieldKey
      lastFieldKey = key
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        const tree = currentTree(s.project!, s.currentReviewer, paper, true)
        if (!tree) return
        const container = containerAt(tree, path)
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
      if (prev.project.reviewers > 1 && prev.currentReviewer === null) return
      lastFieldKey = null
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        const tree = currentTree(s.project!, s.currentReviewer, paper, true)
        if (!tree) return
        const container = containerAt(tree, path)
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
      if (prev.project.reviewers > 1 && prev.currentReviewer === null) return
      lastFieldKey = null
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        const tree = currentTree(s.project!, s.currentReviewer, paper, true)
        if (!tree) return
        const container = containerAt(tree, path)
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
      if (prev.project.reviewers > 1 && prev.currentReviewer === null) {
        return { filled: 0, skipped: suggestions.length }
      }
      // Consolidation reconciles what the reviewers said; a model's answer is
      // not one of the things being reconciled, and this tree is the one that
      // ships. `AnnotationPanel` hides the button here, so the only way in is to
      // open the dialog as a reviewer and then switch seats — refuse that too,
      // rather than trust the UI to be the whole guard.
      if (prev.currentReviewer === 'consolidation') {
        return { filled: 0, skipped: suggestions.length }
      }
      const schema = prev.project.schema
      const paperNow = currentPaper(prev)
      if (!paperNow) return { filled: 0, skipped: suggestions.length }
      // Read-only: whichever reviewer is active right now is who "answered
      // already" is checked against — see `currentTree`.
      const readTree = currentTree(prev.project, prev.currentReviewer, paperNow)
      if (!readTree) return { filled: 0, skipped: suggestions.length }

      // Decide what to write *before* touching anything, so a run that turns out to
      // change nothing leaves no empty entry on the undo stack. A suggestion is
      // dropped if its path no longer resolves, or if the field has since been
      // answered — the reviewer's own work is never overwritten.
      const accepted = suggestions.flatMap((sug) => {
        const at = resolvePath(schema, sug.path)
        if (!at) return []
        const current = peekValue(readTree, at.path, at.name, at.index)
        if (!isUnanswered(at.def, current)) return []
        return [{ at, value: sug.value }]
      })
      if (accepted.length === 0) return { filled: 0, skipped: suggestions.length }

      // The whole fill is one undo step: snapshot once, then mutate. Reset the
      // coalescing key, or the reviewer's next keystroke would be folded into it.
      lastFieldKey = null
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      const paperId = paperNow.id
      const reviewerScope = markReviewerScope(prev.project, prev.currentReviewer)
      let filled = 0
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        const target = currentTree(s.project!, s.currentReviewer, paper, true)
        if (!target) return
        pushPast(s, snap)
        for (const { at, value } of accepted) {
          // The model may address an entry of a repeatable node that does not exist
          // yet — that is how it records a further Finding. Create the instances it
          // named, along the whole path.
          let level: ResolvedDef[] = s.project!.schema
          let cursor: AnnotationValueTree | null = target
          for (const seg of at.path) {
            const step = ensureInstance(level, cursor, seg.name, seg.index)
            if (!step) {
              cursor = null
              break
            }
            if (!step.inst.children) step.inst.children = {}
            cursor = step.inst.children
            level = step.def.children
          }
          if (!cursor) continue
          const leaf = ensureInstance(level, cursor, at.name, at.index)
          if (!leaf) continue
          leaf.inst.value = value
          // Mark only what was actually written: a skipped suggestion left the
          // field as the reviewer had it, and must not be flagged as the AI's.
          s.aiMarks[aiMarkKey(paperId, at.canonical, reviewerScope)] = true
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
      const { project, currentReviewer } = get()
      const key = aiMarkKey(paperId, canonicalPath, markReviewerScope(project, currentReviewer))
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

    selectReviewer: (reviewer) => {
      // A view switch, not an edit: no undo step, no dirty flag — only the
      // persisted selection and the visible state change.
      saveCurrentReviewer(get().saveHandle, reviewer)
      set((s) => {
        s.currentReviewer = reviewer
      })
    },

    openConsolidation: (path, name, index) =>
      set((s) => {
        s.consolidationTarget = { path, name, index }
      }),

    closeConsolidation: () =>
      set((s) => {
        s.consolidationTarget = null
      }),

    alignConsolidationNode: (paperId, nodeName, coalesce) => {
      const prev = get()
      const project = prev.project
      if (!project || project.reviewers <= 1) return false
      const paper = project.papers.find((p) => p.id === paperId)
      if (!paper) return false
      const def = project.schema.find((d) => d.name === nodeName)
      if (!def) return false

      // Once the consolidator has committed an answer under this node, its
      // entry N means a particular thing to them, and re-matching could quietly
      // move a different entry into slot N — their recorded answer would then
      // describe something it was never about. Matching is a service offered
      // before the work starts, not a thing done underneath it.
      //
      // The cost is that entries a reviewer adds *after* consolidation began are
      // not auto-matched for this node; comparing them by hand still works. That
      // is the safe side of the trade: a stale match is visible, a silently
      // re-pointed answer is not.
      if (hasAnnotations([def], { [nodeName]: paper.annotations[nodeName] ?? [] })) return false

      // Only the numbered reviewers get a vote. The consolidated tree is what
      // is being built out of them, so letting it match against itself would be
      // circular.
      const reviews: Record<string, AnnotationValueTree> = {}
      for (let i = 1; i <= project.reviewers; i++) {
        const tree = paper.reviews[String(i)]
        if (tree) reviews[String(i)] = tree
      }
      if (Object.keys(reviews).length < 2) return false

      // Computed against the current (frozen) state before opening a draft: this
      // is the expensive part, and immer drafts are not worth proxying it through.
      const alignment = alignNode(project.schema, reviews, nodeName)
      const snap: HistoryEntry = { project, paperId: prev.currentPaperId }

      let changed = false
      set((s) => {
        const draft = s.project!.papers.find((p) => p.id === paperId)
        if (!draft) return
        const draftReviews: Record<string, AnnotationValueTree> = {}
        for (const r of Object.keys(reviews)) draftReviews[r] = draft.reviews[r]
        changed = applyAlignment(s.project!.schema, alignment, draftReviews, draft.annotations)
        if (!changed) return
        // One undo step for the whole paper, not one per node: the reviewer sees
        // a single "the entries were lined up" event and undoes it in one press.
        // `coalesce` is the scheduler saying this is a later node of a run whose
        // first node already took the snapshot.
        if (!coalesce) pushPast(s, snap)
        s.dirty = true
      })
      // A value typed after this must not merge into the alignment's undo entry.
      if (changed) lastFieldKey = null
      return changed
    },

    adoptUnanimousValues: (paperId, coalesce) => {
      const prev = get()
      const project = prev.project
      if (!project || project.reviewers <= 1) return 0
      const paper = project.papers.find((p) => p.id === paperId)
      if (!paper) return 0

      // Every numbered reviewer, present or not: a reviewer with no tree has not
      // answered, and `unanimousFills` needs to see that rather than count the
      // agreement of whoever happens to be here.
      const reviews: Record<string, AnnotationValueTree | undefined> = {}
      for (let i = 1; i <= project.reviewers; i++) reviews[String(i)] = paper.reviews[String(i)]

      const fills = unanimousFills(project.schema, reviews, paper.annotations)
      if (fills.length === 0) return 0

      const snap: HistoryEntry = { project, paperId: prev.currentPaperId }
      set((s) => {
        const draft = s.project!.papers.find((p) => p.id === paperId)
        if (!draft) return
        if (!coalesce) pushPast(s, snap)
        for (const fill of fills) {
          const container = containerAt(draft.annotations, fill.path)
          const inst = container[fill.name]?.[fill.index]
          if (!inst) continue
          inst.value = fill.value
          // The same mark the AI's fills get: the value is the app's doing until
          // the consolidator has looked at it, and it says so on screen. Scoped
          // to Consolidation, which is the only seat that can produce these.
          s.aiMarks[aiMarkKey(paperId, fill.canonical, 'consolidation')] = true
        }
        s.dirty = true
      })
      lastFieldKey = null
      return fills.length
    },

    toggleFieldEquality: (paperId, canonical) => {
      const prev = get()
      if (!prev.project) return
      if (!prev.project.papers.some((p) => p.id === paperId)) return

      // A real data change — one undo step, same as any other write — not a
      // view toggle: it changes what the saved file says about the papers.
      lastFieldKey = null
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      set((s) => {
        const draft = s.project!.papers.find((p) => p.id === paperId)
        if (!draft) return
        pushPast(s, snap)
        const i = draft.equal.indexOf(canonical)
        if (i >= 0) draft.equal.splice(i, 1)
        else draft.equal.push(canonical)
        s.dirty = true
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
 * the model asked to add. Exported so the consolidation compare popup can read
 * the same value out of any reviewer's tree without a second implementation.
 */
export function peekValue(
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
  const marked = useStore((s) => {
    if (s.currentPaperId === null) return false
    const key = aiMarkKey(s.currentPaperId, canonical, markReviewerScope(s.project, s.currentReviewer))
    return s.aiMarks[key] === true
  })
  const confirm = () => {
    const paperId = useStore.getState().currentPaperId
    if (paperId) useStore.getState().confirmAiMark(paperId, canonical)
  }
  return [marked, confirm]
}
