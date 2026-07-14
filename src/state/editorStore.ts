import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { z } from 'zod'
import { projectSchema, resolveSchema, SchemaError, type AnnotationDef } from '../model/schema'
import { extractPdfMeta } from '../model/pdfMeta'
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
  /** The reviewer must fill this field in; meaningless on a group. */
  required: boolean
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

/**
 * One undo/redo snapshot of the draft. immer gives every field structural
 * sharing, so holding previous versions is cheap — only the edited path differs.
 */
interface EditorSnapshot {
  nodes: EditorNode[]
  papers: EditorPaper[]
  location: ProjectLocation | null
  version: number
  title: string
  extra: Record<string, unknown>
}

const HISTORY_LIMIT = 100

/**
 * The last edited field, so consecutive edits to the *same* input (typing a
 * name character by character) collapse into one undo step instead of one per
 * keystroke. Any other action resets it. Mirrors the annotation store.
 */
let lastEditKey: string | null = null

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
    required: false,
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
    if (n.kind !== 'group' && n.required) def.required = true
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
    required: d.required ?? false,
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

/** A human title guessed from a PDF file name (a placeholder until the PDF is read). */
export function titleFromName(name: string): string {
  return name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim()
}

/**
 * Identity of a referenced PDF, for duplicate detection. The absolute path is
 * the truth when we have one (Electron); otherwise the stored relative path is
 * the best we can do (the browser exposes no paths).
 */
export function pdfKeys(paper: Pick<EditorPaper, 'pdf' | 'sourcePath'>): string[] {
  const keys: string[] = []
  if (paper.sourcePath) keys.push(paper.sourcePath)
  if (paper.pdf) keys.push(paper.pdf)
  return keys
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
  title?: string
  extra: Record<string, unknown>
  nodes: EditorNode[]
  papers: EditorPaper[]
}): Record<string, unknown> {
  const title = state.title?.trim()
  return {
    ...state.extra,
    version: state.version,
    // Omitted when blank, so the app falls back to the file name.
    ...(title ? { title } : {}),
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
  title?: string
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
  /** The project's display title; empty means "use the file name". */
  title: string
  extra: Record<string, unknown>
  nodes: EditorNode[]
  papers: EditorPaper[]
  dirty: boolean
  busy: boolean
  error: EditorError | null
  /** Validation problems from the last save attempt. */
  issues: string[]
  /** Transient info, e.g. which duplicate PDFs were skipped. */
  notice: string | null
  /** How many just-added PDFs are still being read for their title/authors. */
  extracting: number
  /** Undo/redo history of draft edits (session-only). */
  past: EditorSnapshot[]
  future: EditorSnapshot[]

  startNew: () => Promise<void>
  startEdit: () => Promise<void>
  close: () => void
  changeLocation: () => Promise<void>
  setTitle: (title: string) => void

  addNode: (parentUid: string | null) => void
  updateNode: (uid: string, patch: Partial<EditorNode>) => void
  removeNode: (uid: string) => void
  moveNode: (dragUid: string, targetUid: string, position: DropPosition) => void
  toggleCollapsed: (uid: string) => void

  addPdfs: () => Promise<void>
  updatePaper: (uid: string, patch: Partial<EditorPaper>) => void
  removePaper: (uid: string) => void
  movePaper: (dragUid: string, targetUid: string, position: 'before' | 'after') => void

  undo: () => void
  redo: () => void

  /** Write the JSON and stay in the editor. */
  save: () => Promise<boolean>
  /** Pick a new location, then write there. */
  saveAs: () => Promise<boolean>
  /** Write the JSON, then open it in the annotation view. */
  saveAndAnnotate: () => Promise<boolean>
  clearError: () => void
  clearNotice: () => void
}

/** The parts of the draft that undo/redo restores. */
function snapshotOf(s: EditorState): EditorSnapshot {
  return {
    nodes: s.nodes,
    papers: s.papers,
    location: s.location,
    version: s.version,
    title: s.title,
    extra: s.extra,
  }
}

function applySnapshot(s: EditorState, snap: EditorSnapshot): void {
  s.nodes = snap.nodes
  s.papers = snap.papers
  s.location = snap.location
  s.version = snap.version
  s.title = snap.title
  s.extra = snap.extra
}

/** Push a pre-mutation snapshot onto the undo stack and drop the redo stack. */
function pushPast(s: EditorState, snap: EditorSnapshot): void {
  s.past.push(snap)
  if (s.past.length > HISTORY_LIMIT) s.past.shift()
  s.future = []
}

export const useEditorStore = create<EditorState>()(
  immer((set, get) => ({
    open: false,
    mode: 'new',
    location: null,
    version: 1,
    title: '',
    extra: {},
    nodes: [],
    papers: [],
    dirty: false,
    busy: false,
    error: null,
    issues: [],
    notice: null,
    extracting: 0,
    past: [],
    future: [],

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
        s.title = ''
        s.extra = {}
        s.nodes = [makeNode()]
        s.papers = []
        s.dirty = false
        s.busy = false
        s.error = null
        s.issues = []
        s.notice = null
        s.extracting = 0
        s.past = []
        s.future = []
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
          if (!['version', 'title', 'config', 'papers'].includes(k)) rootExtra[k] = v
        }
        set((s) => {
          s.open = true
          s.mode = 'edit'
          s.location = { handle: opened.handle, name: opened.name, path: opened.handle.path }
          s.version = parsed.version ?? 1
          s.title = parsed.title ?? ''
          s.extra = rootExtra
          s.nodes = fromAnnotationDefs(parsed.config.schema)
          s.papers = papers
          s.dirty = false
          s.busy = false
          s.error = null
          s.issues = []
          s.notice = null
          s.extracting = 0
          s.past = []
          s.future = []
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
        s.notice = null
      }),

    clearError: () =>
      set((s) => {
        s.error = null
      }),

    clearNotice: () =>
      set((s) => {
        s.notice = null
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
      const snap = snapshotOf(get())
      lastEditKey = null
      set((s) => {
        pushPast(s, snap)
        s.location = location
        let i = 0
        for (const p of s.papers) {
          if (p.sourcePath) p.pdf = rederived[i++] ?? p.pdf
        }
        s.dirty = true
      })
    },

    setTitle: (title) => {
      const key = 'project:title'
      const coalesce = key === lastEditKey
      lastEditKey = key
      const snap = snapshotOf(get())
      set((s) => {
        if (!coalesce) pushPast(s, snap)
        s.title = title
        s.dirty = true
      })
    },

    addNode: (parentUid) => {
      const snap = snapshotOf(get())
      lastEditKey = null
      set((s) => {
        const node = makeNode()
        if (!parentUid) {
          pushPast(s, snap)
          s.nodes.push(node)
        } else {
          const parent = findNode(s.nodes, parentUid)
          if (!parent) return
          pushPast(s, snap)
          parent.children.push(node)
          parent.collapsed = false
        }
        s.dirty = true
      })
    },

    updateNode: (uid, patch) => {
      // Typing into one input is a single undo step, not one per keystroke.
      const key = `node:${uid}:${Object.keys(patch).sort().join(',')}`
      const coalesce = key === lastEditKey
      lastEditKey = key
      const snap = snapshotOf(get())
      set((s) => {
        const node = findNode(s.nodes, uid)
        if (!node) return
        if (!coalesce) pushPast(s, snap)
        Object.assign(node, patch)
        // Enum options only exist on string fields.
        if (node.kind !== 'string') node.options = []
        // A group holds no value, so it cannot be required.
        if (node.kind === 'group') node.required = false
        s.dirty = true
      })
    },

    removeNode: (uid) => {
      const snap = snapshotOf(get())
      lastEditKey = null
      set((s) => {
        pushPast(s, snap)
        findAndRemove(s.nodes, uid)
        s.dirty = true
      })
    },

    moveNode: (dragUid, targetUid, position) => {
      const snap = snapshotOf(get())
      lastEditKey = null
      set((s) => {
        // Only an actual move is worth an undo step.
        if (!moveNodeIn(s.nodes, dragUid, targetUid, position)) return
        pushPast(s, snap)
        s.dirty = true
      })
    },

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

      // Skip PDFs the project already references. Match on the absolute path
      // when we have one, and on the stored relative path otherwise — so
      // re-picking the same file, or one already listed in an edited project,
      // doesn't create a second entry.
      const seen = new Set(get().papers.flatMap(pdfKeys))
      const fresh: { uid: string; placeholder: string; read?: () => Promise<ArrayBuffer> }[] = []
      const skipped: string[] = []
      const snap = snapshotOf(get())
      lastEditKey = null

      set((s) => {
        pushPast(s, snap)
        const ids = new Set(s.papers.map((p) => p.id))
        picked.forEach((pdf, i) => {
          const relPath = rel[i] ?? pdf.name
          if ((pdf.path && seen.has(pdf.path)) || seen.has(relPath)) {
            skipped.push(pdf.name)
            return
          }
          if (pdf.path) seen.add(pdf.path)
          seen.add(relPath)
          const paper = makePaperFromPdf(pdf.name, relPath, pdf.path, ids)
          ids.add(paper.id)
          s.papers.push(paper)
          fresh.push({ uid: paper.uid, placeholder: paper.title, read: pdf.read })
        })
        if (fresh.length > 0) s.dirty = true
        s.notice =
          skipped.length > 0
            ? `Already in the project, skipped: ${skipped.join(', ')}`
            : null
        s.extracting += fresh.length
      })

      // Read each PDF's title/authors in the background: the rows are already on
      // screen with a name-derived placeholder, so this only improves them.
      await Promise.all(
        fresh.map(async (entry) => {
          try {
            const meta = entry.read ? await extractPdfMeta(await entry.read()) : {}
            set((s) => {
              const paper = s.papers.find((p) => p.uid === entry.uid)
              if (!paper) return
              // Don't clobber anything the user typed while we were reading.
              if (meta.title && paper.title === entry.placeholder) paper.title = meta.title
              if (meta.authors?.length && !paper.authors.trim()) {
                paper.authors = meta.authors.join(', ')
              }
            })
          } catch {
            // Unreadable PDF — keep the name-derived placeholder.
          } finally {
            set((s) => {
              s.extracting = Math.max(0, s.extracting - 1)
            })
          }
        }),
      )
    },

    updatePaper: (uid, patch) => {
      const key = `paper:${uid}:${Object.keys(patch).sort().join(',')}`
      const coalesce = key === lastEditKey
      lastEditKey = key
      const snap = snapshotOf(get())
      set((s) => {
        const paper = s.papers.find((p) => p.uid === uid)
        if (!paper) return
        if (!coalesce) pushPast(s, snap)
        Object.assign(paper, patch)
        s.dirty = true
      })
    },

    removePaper: (uid) => {
      const snap = snapshotOf(get())
      lastEditKey = null
      set((s) => {
        pushPast(s, snap)
        s.papers = s.papers.filter((p) => p.uid !== uid)
        s.dirty = true
      })
    },

    movePaper: (dragUid, targetUid, position) => {
      const snap = snapshotOf(get())
      lastEditKey = null
      set((s) => {
        if (dragUid === targetUid) return
        const from = s.papers.findIndex((p) => p.uid === dragUid)
        if (from === -1) return
        pushPast(s, snap)
        const [paper] = s.papers.splice(from, 1)
        const at = s.papers.findIndex((p) => p.uid === targetUid)
        if (at === -1) {
          s.papers.push(paper)
        } else {
          s.papers.splice(position === 'before' ? at : at + 1, 0, paper)
        }
        s.dirty = true
      })
    },

    undo: () => {
      const st = get()
      if (st.past.length === 0) return
      lastEditKey = null
      const entry = st.past[st.past.length - 1]
      const current = snapshotOf(st)
      set((s) => {
        s.past.pop()
        s.future.unshift(current)
        if (s.future.length > HISTORY_LIMIT) s.future.pop()
        applySnapshot(s, entry)
        s.dirty = true
      })
    },

    redo: () => {
      const st = get()
      if (st.future.length === 0) return
      lastEditKey = null
      const entry = st.future[0]
      const current = snapshotOf(st)
      set((s) => {
        s.future.shift()
        s.past.push(current)
        if (s.past.length > HISTORY_LIMIT) s.past.shift()
        applySnapshot(s, entry)
        s.dirty = true
      })
    },

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
        s.notice = null
      })
      try {
        const text = JSON.stringify(buildProjectJson(st), null, 2)
        const handle = await getPlatform().saveProject(text, st.location.handle)
        set((s) => {
          s.busy = false
          s.dirty = false
          if (s.location) s.location.handle = handle
          // Saving only writes the file — the user stays in the editor.
          s.notice = `Saved to ${st.location?.name ?? 'the project file'}`
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

    saveAs: async () => {
      await get().changeLocation()
      // changeLocation is a no-op if the user cancels, so this just re-saves to
      // the existing location in that case.
      return get().save()
    },

    saveAndAnnotate: async () => {
      if (!(await get().save())) return false
      const st = get()
      if (!st.location) return false
      // Hand the saved project straight to the annotation view.
      const text = JSON.stringify(buildProjectJson(st), null, 2)
      useStore.getState().loadFromText(text, st.location.handle, st.location.name)
      set((s) => {
        s.open = false
        s.notice = null
      })
      return true
    },
  })),
)
