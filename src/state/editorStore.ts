import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { z } from 'zod'
import { projectSchema, resolveSchema, SchemaError, type AnnotationDef } from '../model/schema'
import { getPlatform, type ProjectLocation } from '../platform'
import { useStore } from './store'

/**
 * Draft state for the project editor: build or edit a project JSON (its
 * annotation schema + the PDFs it references) before/without annotating.
 *
 * The editor works on the *raw* JSON shape rather than the loaded `Project`, so
 * existing papers' `annotations` are preserved verbatim while the schema is
 * edited. They are normalized against the (possibly changed) schema the next
 * time the project is opened for annotating.
 */

/** A schema node in the editor. `group` means "no `type`" — a name-only sub-tree. */
export type EditorNodeKind = 'group' | 'string' | 'number' | 'boolean'

export interface EditorNode {
  /** Client-side id, stable across renders. Used for React keys and drag/drop. */
  uid: string
  name: string
  kind: EditorNodeKind
  min: number
  /** null = unbounded. */
  max: number | null
  description: string
  /** Enum values; only meaningful when kind === 'string'. */
  options: string[]
  children: EditorNode[]
  collapsed: boolean
}

export interface EditorPaper {
  uid: string
  id: string
  title: string
  /** Comma-separated in the UI; split on save. */
  authors: string
  doi: string
  /** The relative path written to the JSON. */
  pdf: string
  /** Absolute source path (Electron only) so `pdf` can be re-derived if the JSON moves. */
  sourcePath?: string
  /** Preserved verbatim when editing an existing file. */
  annotations?: unknown
  extra?: Record<string, unknown>
}

export interface EditorError {
  message: string
  details: string[]
}

/** Where a node is dropped relative to the target. */
export type DropPosition = 'before' | 'after' | 'inside'

let uidCounter = 0
const nextUid = () => `n${uidCounter++}`

export function makeNode(): EditorNode {
  return {
    uid: nextUid(),
    name: '',
    kind: 'string',
    min: 1,
    max: 1,
    description: '',
    options: [],
    children: [],
    collapsed: false,
  }
}

// ---------------------------------------------------------------------------
// Conversion between the editor tree and the on-disk AnnotationDef shape
// ---------------------------------------------------------------------------

/** Editor tree → the compact AnnotationDef[] written to `config.schema`. */
export function toAnnotationDefs(nodes: EditorNode[]): AnnotationDef[] {
  return nodes.map((n) => {
    const def: AnnotationDef = { name: n.name.trim() }
    if (n.kind !== 'group') def.type = n.kind
    if (n.min !== 1) def.min = n.min
    if (n.max !== 1) def.max = n.max
    const desc = n.description.trim()
    if (desc) def.description = desc
    const opts = n.options.map((o) => o.trim()).filter(Boolean)
    if (n.kind === 'string' && opts.length > 0) def.options = opts
    if (n.children.length > 0) def.children = toAnnotationDefs(n.children)
    return def
  })
}

/** AnnotationDef[] from an existing file → editor tree (assigning uids). */
export function fromAnnotationDefs(defs: AnnotationDef[]): EditorNode[] {
  return defs.map((d) => ({
    uid: nextUid(),
    name: d.name,
    kind: (d.type ?? 'group') as EditorNodeKind,
    min: d.min ?? 1,
    max: d.max === undefined ? 1 : d.max,
    description: d.description ?? '',
    options: d.options ? [...d.options] : [],
    children: d.children ? fromAnnotationDefs(d.children) : [],
    collapsed: false,
  }))
}

// ---------------------------------------------------------------------------
// Tree helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

function findAndRemove(nodes: EditorNode[], uid: string): EditorNode | null {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].uid === uid) return nodes.splice(i, 1)[0]
    const found = findAndRemove(nodes[i].children, uid)
    if (found) return found
  }
  return null
}

function findNode(nodes: EditorNode[], uid: string): EditorNode | null {
  for (const n of nodes) {
    if (n.uid === uid) return n
    const found = findNode(n.children, uid)
    if (found) return found
  }
  return null
}

/** True if `uid` is `ancestorUid` or lives underneath it (guards illegal moves). */
export function isSelfOrDescendant(nodes: EditorNode[], ancestorUid: string, uid: string): boolean {
  const ancestor = findNode(nodes, ancestorUid)
  if (!ancestor) return false
  if (ancestor.uid === uid) return true
  return findNode(ancestor.children, uid) !== null
}

/** Insert `node` relative to `targetUid`. Returns false if the target is gone. */
function insertRelative(
  nodes: EditorNode[],
  targetUid: string,
  node: EditorNode,
  position: DropPosition,
): boolean {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].uid === targetUid) {
      if (position === 'inside') nodes[i].children.push(node)
      else nodes.splice(position === 'before' ? i : i + 1, 0, node)
      return true
    }
    if (insertRelative(nodes[i].children, targetUid, node, position)) return true
  }
  return false
}

/**
 * Move a node in the tree. A node cannot be dropped into itself or its own
 * subtree (that would detach the subtree from the root), so such moves are
 * rejected. Exported for tests.
 */
export function moveNodeIn(
  nodes: EditorNode[],
  dragUid: string,
  targetUid: string,
  position: DropPosition,
): boolean {
  if (dragUid === targetUid) return false
  if (isSelfOrDescendant(nodes, dragUid, targetUid)) return false
  const node = findAndRemove(nodes, dragUid)
  if (!node) return false
  if (!insertRelative(nodes, targetUid, node, position)) {
    // Target vanished (shouldn't happen) — put it back at the top level.
    nodes.push(node)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Building + validating the project JSON
// ---------------------------------------------------------------------------

/** Slugify a file name into a stable paper id. */
function paperIdFromName(name: string): string {
  return (
    name
      .replace(/\.pdf$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'paper'
  )
}

/** A human title guessed from a PDF file name. */
function titleFromName(name: string): string {
  return name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim()
}

export function makePaperFromPdf(
  fileName: string,
  relativePath: string,
  sourcePath: string | undefined,
  existingIds: Set<string>,
): EditorPaper {
  let id = paperIdFromName(fileName)
  let n = 2
  while (existingIds.has(id)) id = `${paperIdFromName(fileName)}-${n++}`
  return {
    uid: nextUid(),
    id,
    title: titleFromName(fileName),
    authors: '',
    doi: '',
    pdf: relativePath,
    sourcePath,
    annotations: {},
  }
}

/** Assemble the raw JSON object the editor writes. */
export function buildProjectJson(state: {
  version: number
  extra: Record<string, unknown>
  nodes: EditorNode[]
  papers: EditorPaper[]
}): Record<string, unknown> {
  return {
    ...state.extra,
    version: state.version,
    config: { schema: toAnnotationDefs(state.nodes) },
    papers: state.papers.map((p) => {
      const out: Record<string, unknown> = { ...(p.extra ?? {}) }
      out.id = p.id.trim()
      out.title = p.title.trim()
      out.authors = p.authors
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
      if (p.doi.trim()) out.doi = p.doi.trim()
      out.pdf = p.pdf.trim()
      out.annotations = p.annotations ?? {}
      return out
    }),
  }
}

/**
 * Validate a draft the same way loading does (structure + schema resolution),
 * plus editor-specific checks. Returns [] when the draft is valid.
 */
export function validateDraft(state: {
  version: number
  extra: Record<string, unknown>
  nodes: EditorNode[]
  papers: EditorPaper[]
}): string[] {
  const errors: string[] = []

  if (state.nodes.length === 0) {
    errors.push('The annotation schema needs at least one field.')
  }
  const unnamed = countUnnamed(state.nodes)
  if (unnamed > 0) errors.push(`${unnamed} schema field(s) have no name.`)

  state.papers.forEach((p, i) => {
    if (!p.id.trim()) errors.push(`Paper ${i + 1}: missing id.`)
    if (!p.title.trim()) errors.push(`Paper ${i + 1}: missing title.`)
    if (!p.pdf.trim()) errors.push(`Paper ${i + 1}: missing PDF path.`)
  })
  const ids = state.papers.map((p) => p.id.trim()).filter(Boolean)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dupes.length > 0) errors.push(`Duplicate paper id(s): ${[...new Set(dupes)].join(', ')}.`)

  // Only run the structural validators once the basics hold, so their messages
  // don't pile on top of the friendlier ones above.
  if (errors.length > 0) return errors

  const json = buildProjectJson(state)
  try {
    const raw = projectSchema.parse(json)
    resolveSchema(raw.config.schema)
  } catch (err) {
    if (err instanceof z.ZodError) {
      errors.push(...err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`))
    } else if (err instanceof SchemaError) {
      errors.push(err.message)
    } else {
      errors.push(String(err))
    }
  }
  return errors
}

function countUnnamed(nodes: EditorNode[]): number {
  return nodes.reduce(
    (acc, n) => acc + (n.name.trim() ? 0 : 1) + countUnnamed(n.children),
    0,
  )
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface EditorState {
  open: boolean
  mode: 'new' | 'edit'
  location: ProjectLocation | null
  version: number
  extra: Record<string, unknown>
  nodes: EditorNode[]
  papers: EditorPaper[]
  dirty: boolean
  busy: boolean
  error: EditorError | null
  /** Validation problems from the last save attempt. */
  issues: string[]

  startNew: () => Promise<void>
  startEdit: () => Promise<void>
  close: () => void
  changeLocation: () => Promise<void>

  addNode: (parentUid: string | null) => void
  updateNode: (uid: string, patch: Partial<EditorNode>) => void
  removeNode: (uid: string) => void
  moveNode: (dragUid: string, targetUid: string, position: DropPosition) => void
  toggleCollapsed: (uid: string) => void

  addPdfs: () => Promise<void>
  updatePaper: (uid: string, patch: Partial<EditorPaper>) => void
  removePaper: (uid: string) => void
  movePaper: (dragUid: string, targetUid: string, position: 'before' | 'after') => void

  save: () => Promise<boolean>
  clearError: () => void
}

export const useEditorStore = create<EditorState>()(
  immer((set, get) => ({
    open: false,
    mode: 'new',
    location: null,
    version: 1,
    extra: {},
    nodes: [],
    papers: [],
    dirty: false,
    busy: false,
    error: null,
    issues: [],

    startNew: async () => {
      const platform = getPlatform()
      // The location is chosen up front: PDF paths are stored relative to it.
      const location = await platform.pickProjectLocation('project.json')
      if (!location) return
      set((s) => {
        s.open = true
        s.mode = 'new'
        s.location = location
        s.version = 1
        s.extra = {}
        s.nodes = [makeNode()]
        s.papers = []
        s.dirty = false
        s.busy = false
        s.error = null
        s.issues = []
      })
    },

    startEdit: async () => {
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
        const data = JSON.parse(opened.text) as Record<string, unknown>
        const parsed = projectSchema.parse(data)
        const papers: EditorPaper[] = parsed.papers.map((p) => {
          const known = new Set(['id', 'title', 'authors', 'doi', 'pdf', 'annotations'])
          const extra: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(p)) if (!known.has(k)) extra[k] = v
          return {
            uid: nextUid(),
            id: p.id,
            title: p.title,
            authors: (p.authors ?? []).join(', '),
            doi: p.doi ?? '',
            pdf: p.pdf,
            // No absolute source: the file already stores a relative path, and
            // we only re-derive paths for PDFs the user adds in this session.
            sourcePath: undefined,
            annotations: p.annotations ?? {},
            extra,
          }
        })
        const rootExtra: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(data)) {
          if (!['version', 'config', 'papers'].includes(k)) rootExtra[k] = v
        }
        set((s) => {
          s.open = true
          s.mode = 'edit'
          s.location = { handle: opened.handle, name: opened.name, path: opened.handle.path }
          s.version = parsed.version ?? 1
          s.extra = rootExtra
          s.nodes = fromAnnotationDefs(parsed.config.schema)
          s.papers = papers
          s.dirty = false
          s.busy = false
          s.error = null
          s.issues = []
        })
      } catch (err) {
        const details =
          err instanceof z.ZodError
            ? err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            : [String(err)]
        set((s) => {
          s.busy = false
          s.error = { message: 'That file could not be opened for editing.', details }
        })
      }
    },

    close: () =>
      set((s) => {
        s.open = false
        s.error = null
        s.issues = []
      }),

    clearError: () =>
      set((s) => {
        s.error = null
      }),

    changeLocation: async () => {
      const platform = getPlatform()
      const current = get().location
      const location = await platform.pickProjectLocation(current?.name ?? 'project.json')
      if (!location) return
      // PDFs are referenced relative to the JSON, so moving the JSON re-derives
      // every path we still know an absolute source for.
      const papers = get().papers
      const withSource = papers.filter((p) => p.sourcePath)
      let rederived: string[] = []
      if (withSource.length > 0) {
        rederived = await platform.relativePdfPaths(
          withSource.map((p) => ({ name: p.pdf, path: p.sourcePath })),
          location,
        )
      }
      set((s) => {
        s.location = location
        let i = 0
        for (const p of s.papers) {
          if (p.sourcePath) p.pdf = rederived[i++] ?? p.pdf
        }
        s.dirty = true
      })
    },

    addNode: (parentUid) =>
      set((s) => {
        const node = makeNode()
        if (!parentUid) {
          s.nodes.push(node)
        } else {
          const parent = findNode(s.nodes, parentUid)
          if (!parent) return
          parent.children.push(node)
          parent.collapsed = false
        }
        s.dirty = true
      }),

    updateNode: (uid, patch) =>
      set((s) => {
        const node = findNode(s.nodes, uid)
        if (!node) return
        Object.assign(node, patch)
        // Enum options only exist on string fields.
        if (node.kind !== 'string') node.options = []
        s.dirty = true
      }),

    removeNode: (uid) =>
      set((s) => {
        findAndRemove(s.nodes, uid)
        s.dirty = true
      }),

    moveNode: (dragUid, targetUid, position) =>
      set((s) => {
        if (moveNodeIn(s.nodes, dragUid, targetUid, position)) s.dirty = true
      }),

    toggleCollapsed: (uid) =>
      set((s) => {
        const node = findNode(s.nodes, uid)
        if (node) node.collapsed = !node.collapsed
      }),

    addPdfs: async () => {
      const platform = getPlatform()
      const picked = await platform.pickPdfs()
      if (picked.length === 0) return
      const rel = await platform.relativePdfPaths(picked, get().location)
      set((s) => {
        const ids = new Set(s.papers.map((p) => p.id))
        picked.forEach((pdf, i) => {
          const paper = makePaperFromPdf(pdf.name, rel[i] ?? pdf.name, pdf.path, ids)
          ids.add(paper.id)
          s.papers.push(paper)
        })
        s.dirty = true
      })
    },

    updatePaper: (uid, patch) =>
      set((s) => {
        const paper = s.papers.find((p) => p.uid === uid)
        if (!paper) return
        Object.assign(paper, patch)
        s.dirty = true
      }),

    removePaper: (uid) =>
      set((s) => {
        s.papers = s.papers.filter((p) => p.uid !== uid)
        s.dirty = true
      }),

    movePaper: (dragUid, targetUid, position) =>
      set((s) => {
        if (dragUid === targetUid) return
        const from = s.papers.findIndex((p) => p.uid === dragUid)
        if (from === -1) return
        const [paper] = s.papers.splice(from, 1)
        const at = s.papers.findIndex((p) => p.uid === targetUid)
        if (at === -1) {
          s.papers.push(paper)
        } else {
          s.papers.splice(position === 'before' ? at : at + 1, 0, paper)
        }
        s.dirty = true
      }),

    save: async () => {
      const st = get()
      if (!st.location) {
        set((s) => {
          s.error = { message: 'Choose where the JSON should be stored first.', details: [] }
        })
        return false
      }
      const issues = validateDraft(st)
      if (issues.length > 0) {
        set((s) => {
          s.issues = issues
        })
        return false
      }
      set((s) => {
        s.busy = true
        s.issues = []
      })
      try {
        const text = JSON.stringify(buildProjectJson(st), null, 2)
        const handle = await getPlatform().saveProject(text, st.location.handle)
        set((s) => {
          s.busy = false
          s.dirty = false
          if (s.location) s.location.handle = handle
        })
        // Hand the saved project to the annotation view so the user can start
        // working with it right away.
        useStore.getState().loadFromText(text, handle, st.location.name)
        set((s) => {
          s.open = false
        })
        return true
      } catch (err) {
        set((s) => {
          s.busy = false
          s.error = { message: 'Failed to save the project JSON.', details: [String(err)] }
        })
        return false
      }
    },
  })),
)
