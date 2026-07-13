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
import { getPlatform, type SaveHandle } from '../platform'
import { BrowserAdapter } from '../platform/browser'

/** A step into the annotation tree: pick instance `index` of node `name`. */
export interface PathSeg {
  name: string
  index: number
}

export interface LoadError {
  message: string
  details: string[]
}

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

  openProject: () => Promise<void>
  loadFromUrl: (url: string) => Promise<void>
  loadFromText: (text: string, handle: SaveHandle | null, name: string) => void
  save: () => Promise<boolean>
  saveAs: () => Promise<boolean>
  selectPaper: (id: string) => void
  toggleSidebar: () => void
  setPdfSelection: (text: string) => void
  clearError: () => void

  setFieldValue: (path: PathSeg[], name: string, index: number, value: FieldValue) => void
  addInstance: (path: PathSeg[], def: ResolvedDef) => void
  removeInstance: (path: PathSeg[], name: string, index: number) => void
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
      } catch (err) {
        set((s) => {
          s.busy = false
          s.loadError = { message: 'Failed to open the project.', details: [String(err)] }
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
        })
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
      const { project, projectName } = get()
      if (!project) return false
      const platform = getPlatform()
      set((s) => {
        s.busy = true
      })
      try {
        const text = serializeProject(project)
        const suggested = projectName || 'project.json'
        const res = await platform.saveProjectAs(text, suggested)
        if (!res) {
          set((s) => {
            s.busy = false
          })
          return false
        }
        set((s) => {
          s.saveHandle = res.handle
          s.projectName = res.name
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

    selectPaper: (id) =>
      set((s) => {
        s.currentPaperId = id
        s.pdfSelection = ''
      }),

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

    setFieldValue: (path, name, index, value) =>
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        const container = containerAt(paper.annotations, path)
        const inst = container[name]?.[index]
        if (inst) {
          inst.value = value
          s.dirty = true
        }
      }),

    addInstance: (path, def) =>
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        const container = containerAt(paper.annotations, path)
        const list = container[def.name]
        if (list && (def.max === null || list.length < def.max)) {
          list.push(makeInstance(def))
          s.dirty = true
        }
      }),

    removeInstance: (path, name, index) =>
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        const container = containerAt(paper.annotations, path)
        const list = container[name]
        if (list && index >= 0 && index < list.length) {
          list.splice(index, 1)
          s.dirty = true
        }
      }),
  })),
)

function currentPaper(s: AppState) {
  if (!s.project || !s.currentPaperId) return null
  return s.project.papers.find((p) => p.id === s.currentPaperId) ?? null
}

/** Selector: the currently open paper (or null). */
export function selectCurrentPaper(s: AppState) {
  return currentPaper(s)
}
