import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { z } from 'zod'
import {
  projectSchema,
  resolveSchema,
  SchemaError,
  type AnnotationDef,
  type ScreeningConfig,
} from '../model/schema'
import { extractPdfMeta } from '../model/pdfMeta'
import { parseReferences, pdfHintFileName, type RefEntry } from '../model/references'
import { loadProject, type Project } from '../model/project'
import {
  parseReviewerIdentities,
  serializeReviewerIdentities,
  type ReviewerIdentity,
} from '../model/identity'
import { getPlatform, type OpenedProject, type PickedPdf, type ProjectLocation, type SaveHandle } from '../platform'
import { DEFAULT_SCREENING_REASONS, screeningSchemaDefs } from '../screening/schema'
import { screeningReason, screeningStatus } from '../screening/status'
import { pendingUnanimous } from '../screening/counts'
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
  /** What screening reads when there is no PDF attached. */
  abstract: string
  /** The relative path written to the JSON. */
  pdf: string
  /** Absolute source path (Electron only) so `pdf` can be re-derived if the JSON moves. */
  sourcePath?: string
  /** Preserved verbatim when editing an existing file. */
  annotations?: unknown
  /** True when `abstract` came from the PDF-text heuristic (`addPickedPdfs`
   *  below) rather than a reference file or typing — see `Paper.abstractFromPdf`.
   *  Cleared the moment a reference import provides a real one (`fillFromRef`). */
  abstractFromPdf?: boolean
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
  aiEnabled: boolean
  reviewers: number
  screening: ScreeningConfig | null
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
    abstract: '',
    pdf: relativePath,
    sourcePath,
    annotations: {},
  }
}

// ---------------------------------------------------------------------------
// Importing references (BibTeX / RIS / CSL-JSON)
// ---------------------------------------------------------------------------

/** Lowercased, whitespace-collapsed, punctuation-stripped — for matching titles
 *  across sources that differ only in casing/spacing/punctuation. */
function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The existing paper a parsed reference refers to, if any. DOI is the strong
 * signal (exact, case-insensitive); a normalized-title match is the fallback
 * for entries with no DOI, or when the two sources disagree on one.
 */
export function findMatchingPaper(papers: EditorPaper[], entry: RefEntry): EditorPaper | undefined {
  if (entry.doi) {
    const doi = entry.doi.trim().toLowerCase()
    const byDoi = papers.find((p) => p.doi.trim().toLowerCase() === doi)
    if (byDoi) return byDoi
  }
  const title = normalizeTitleForMatch(entry.title)
  if (!title) return undefined
  return papers.find((p) => normalizeTitleForMatch(p.title) === title)
}

/** A new row for a reference with no matching paper. No PDF is attached yet —
 *  `pdfHint`'s file name is a placeholder the user (or a later "Add PDFs…") fills in. */
export function makePaperFromRef(entry: RefEntry, existingIds: Set<string>): EditorPaper {
  const base = entry.title || 'paper'
  let id = paperIdFromName(base)
  let n = 2
  while (existingIds.has(id)) id = `${paperIdFromName(base)}-${n++}`
  return {
    uid: nextUid(),
    id,
    title: entry.title,
    authors: entry.authors.join(', '),
    doi: entry.doi ?? '',
    abstract: entry.abstract ?? '',
    pdf: entry.pdfHint ? pdfHintFileName(entry.pdfHint) : '',
    annotations: {},
  }
}

/** Fill in `match`'s empty fields from `entry`; never overwrites something the
 *  reviewer (or an earlier import) already put there. Returns whether anything changed. */
function fillFromRef(match: EditorPaper, entry: RefEntry): boolean {
  let changed = false
  if (!match.title.trim() && entry.title) {
    match.title = entry.title
    changed = true
  }
  if (!match.authors.trim() && entry.authors.length > 0) {
    match.authors = entry.authors.join(', ')
    changed = true
  }
  if (!match.doi.trim() && entry.doi) {
    match.doi = entry.doi
    changed = true
  }
  // A heuristic-extracted abstract (`abstractFromPdf`) is lower-confidence than
  // one a reference manager actually recorded, so a real one is allowed to
  // replace it — unlike every other field here, which never overwrites
  // something already present.
  if ((!match.abstract.trim() || match.abstractFromPdf) && entry.abstract) {
    match.abstract = entry.abstract
    match.abstractFromPdf = undefined
    changed = true
  }
  return changed
}

function summarizeImport(total: number, updated: number, unchanged: number): string {
  const parts: string[] = []
  if (updated > 0) parts.push(`${updated} updated existing paper${updated === 1 ? '' : 's'}`)
  if (unchanged > 0) parts.push(`${unchanged} already complete`)
  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `Imported ${total} reference${total === 1 ? '' : 's'}${detail}.`
}

/** Assemble the raw JSON object the editor writes. */
export function buildProjectJson(state: {
  version: number
  title?: string
  aiEnabled: boolean
  reviewers: number
  /** Optional so existing test fixtures (and any other caller predating this
   *  feature) keep compiling unchanged — absent means "not a screening draft". */
  screening?: ScreeningConfig | null
  /**
   * Optional for the same reason `screening` is — see there. The editor never
   * *edits* who holds a seat (there is no UI for it here), it only carries the
   * claim through unopened: without this, opening an existing multi-reviewer
   * project in the editor and saving would silently erase every seat claim,
   * re-arming the exact hazard `reviewerIdentities` exists to close.
   */
  reviewerIdentities?: Record<string, ReviewerIdentity>
  extra: Record<string, unknown>
  nodes: EditorNode[]
  papers: EditorPaper[]
}): Record<string, unknown> {
  const title = state.title?.trim()
  const screening = state.screening ?? null
  const reviewerIdentities = serializeReviewerIdentities(state.reviewerIdentities ?? {})
  return {
    ...state.extra,
    version: state.version,
    // Omitted when blank, so the app falls back to the file name.
    ...(title ? { title } : {}),
    // `ai` is only written when disabled, and `reviewers` only when it says
    // more than the single-reviewer default — matching serializeProject.
    config: {
      // A screening draft's schema is the derived projection of its reasons,
      // never the (empty) authored node list — see `Project.screening`.
      schema: screening ? screeningSchemaDefs(screening) : toAnnotationDefs(state.nodes),
      ...(state.aiEnabled ? {} : { ai: false }),
      ...(state.reviewers > 1 ? { reviewers: state.reviewers } : {}),
      ...(reviewerIdentities ? { reviewerIdentities } : {}),
      ...(screening ? { screening: { reasons: screening.reasons } } : {}),
    },
    papers: state.papers.map((p) => {
      const out: Record<string, unknown> = { ...(p.extra ?? {}) }
      out.id = p.id.trim()
      out.title = p.title.trim()
      out.authors = p.authors
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
      if (p.doi.trim()) out.doi = p.doi.trim()
      if (p.abstract && p.abstract.trim()) out.abstract = p.abstract.trim()
      if (p.abstractFromPdf && p.abstract && p.abstract.trim()) out.abstractFromPdf = true
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
  aiEnabled: boolean
  reviewers: number
  /** Optional for the same reason `buildProjectJson`'s is — see there. */
  screening?: ScreeningConfig | null
  extra: Record<string, unknown>
  nodes: EditorNode[]
  papers: EditorPaper[]
}): string[] {
  const errors: string[] = []
  const screening = state.screening ?? null

  if (!screening) {
    // A screening draft has no authored nodes at all — the schema-building
    // section doesn't even render — so these checks are meaningless there.
    if (state.nodes.length === 0) {
      errors.push('The annotation schema needs at least one field.')
    }
    const unnamed = countUnnamed(state.nodes)
    if (unnamed > 0) errors.push(`${unnamed} schema field(s) have no name.`)
  } else if (screening.reasons.filter((r) => r.trim()).length === 0) {
    errors.push('Screening needs at least one exclusion reason.')
  }

  state.papers.forEach((p, i) => {
    if (!p.id.trim()) errors.push(`Paper ${i + 1}: missing id.`)
    if (!p.title.trim()) errors.push(`Paper ${i + 1}: missing title.`)
    // Screening is normally done on title + abstract, from a reference-manager
    // export with no PDFs at all — requiring one there would rule out the
    // whole workflow. Requiring one everywhere else is unchanged.
    if (!p.pdf.trim() && !screening) errors.push(`Paper ${i + 1} has no PDF attached.`)
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
    // `buildProjectJson` always writes a non-empty `config.schema` — derived
    // when screening, authored otherwise — so this is never actually empty;
    // the zod type is merely optional to accommodate a non-screening project
    // whose schema failed validation for some other reason.
    resolveSchema(raw.config.schema ?? [])
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
// Importing from a screening project
// ---------------------------------------------------------------------------

/** One paper carried over from a screening project. Deliberately narrower than
 *  `EditorPaper`: `reviews`/`equal`/`aiUsage` are the screening phase's own
 *  record and mean nothing against a different (annotation) schema. */
export interface ScreeningImportRow {
  id: string
  title: string
  authors: string[]
  doi?: string
  abstract?: string
  /** Carried from `Paper.abstractFromPdf` — the caution stays attached to the
   *  abstract, not to which project file it currently lives in. */
  abstractFromPdf?: boolean
  pdf: string
}

/**
 * What `startFromScreening`/`importFromScreening` found in a screening
 * project, before the reviewer answers "what about the papers nobody screened
 * yet" — see `resolveScreeningImport`, which is what actually commits rows.
 */
export interface ScreeningImportDraft {
  /** `start`: a fresh editor session next to the screening JSON. `import`:
   *  add rows into the editor session already open. */
  target: 'start' | 'import'
  sourceHandle: SaveHandle
  sourceName: string
  screening: ScreeningConfig
  /** Not excluded — `Decision === 'Include'`. Always carried. */
  included: ScreeningImportRow[]
  /** No decision recorded (or an unrecognised one) — carried unless the
   *  reviewer explicitly leaves them out. */
  undecided: ScreeningImportRow[]
  excludedCount: number
  /** Reason → how many excluded papers cited it, for the summary. */
  excludedByReason: Record<string, number>
  /** Papers every reviewer decided identically that Consolidation had not
   *  adopted at the time this was read — see `screening/counts.ts`'s
   *  `pendingUnanimous`. Only ever nonzero when `multiReviewer`. */
  pendingUnanimousCount: number
  multiReviewer: boolean
}

/** `annotations` is the consolidated tree — the one that ships, in both the
 *  single- and multi-reviewer case (see `openwiki/architecture.md`). Reading
 *  `reviews` here would import an individual reviewer's opinion, not the
 *  project's actual result. */
function partitionScreeningPapers(project: Project): {
  included: ScreeningImportRow[]
  undecided: ScreeningImportRow[]
  excludedCount: number
  excludedByReason: Record<string, number>
} {
  const included: ScreeningImportRow[] = []
  const undecided: ScreeningImportRow[] = []
  let excludedCount = 0
  const excludedByReason: Record<string, number> = {}

  for (const p of project.papers) {
    const status = screeningStatus(p.annotations)
    const row: ScreeningImportRow = {
      id: p.id,
      title: p.title,
      authors: p.authors,
      doi: p.doi,
      abstract: p.abstract,
      abstractFromPdf: p.abstractFromPdf,
      pdf: p.pdf,
    }
    if (status === 'included') included.push(row)
    else if (status === 'undecided') undecided.push(row)
    else {
      excludedCount++
      const reason = screeningReason(p.annotations)
      if (reason) excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1
    }
  }
  return { included, undecided, excludedCount, excludedByReason }
}

/** Shared by `startFromScreening`/`importFromScreening`: pick and parse a
 *  screening project, or set `error` and return null. */
async function pickScreeningProject(
  set: (fn: (s: EditorState) => void) => void,
): Promise<{ project: Project; opened: OpenedProject } | null> {
  const opened = await getPlatform().openProject()
  if (!opened) return null
  let project: Project
  try {
    project = loadProject(opened.text)
  } catch (err) {
    set((s) => {
      s.error = openError(err)
    })
    return null
  }
  if (project.screening === null) {
    set((s) => {
      s.error = {
        message: 'That project is not a screening project.',
        details: ['Pick the JSON of a screening project — one whose config has a "screening" section.'],
      }
    })
    return null
  }
  return { project, opened }
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
  /** Whether reviewers may use AI-assisted annotation on this project. */
  aiEnabled: boolean
  /** Independent reviewers before Consolidation reconciles them; 1 = single-reviewer. */
  reviewers: number
  /**
   * Set when this draft is a screening project: its schema is derived from
   * these reasons (see `src/screening/schema.ts`), and `nodes` is unused —
   * `ProjectEditor` renders `ScreeningReasonsEditor` instead of
   * `SchemaTreeEditor` whenever this is non-null.
   */
  screening: ScreeningConfig | null
  /** Carried through unopened — see `buildProjectJson`'s doc comment on its
   *  own `reviewerIdentities` parameter for why this exists at all. */
  reviewerIdentities: Record<string, ReviewerIdentity>
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
  /**
   * Papers added in this session that the reviewer hasn't looked at yet, keyed
   * by `uid`. Mirrors the annotation store's `aiMarks`: session-only, not part
   * of `EditorSnapshot`/undo (an add already has its own undo step; unmarking
   * one is not a meaningful edit to revert to), and never written to the file.
   */
  justAdded: Record<string, true>
  /** Undo/redo history of draft edits (session-only). */
  past: EditorSnapshot[]
  future: EditorSnapshot[]
  /**
   * A screening project picked via `startFromScreening`/`importFromScreening`,
   * parsed and partitioned, waiting on the reviewer's answer to "what about the
   * papers nobody screened yet" before anything is written. Session-only —
   * never part of undo, since nothing has been committed to the draft yet.
   */
  screeningImport: ScreeningImportDraft | null

  startNew: () => Promise<void>
  startEdit: () => Promise<void>
  /** Open a recent project (by its recents id) straight into the schema editor. */
  startEditRecent: (id: string) => Promise<void>
  close: () => void
  changeLocation: () => Promise<void>
  setTitle: (title: string) => void
  setAiEnabled: (enabled: boolean) => void
  setReviewers: (n: number) => void
  /** Turn screening on (seeding `DEFAULT_SCREENING_REASONS`) or off. Its own undo step. */
  setScreening: (on: boolean) => void
  setScreeningReasons: (reasons: string[]) => void

  addNode: (parentUid: string | null) => void
  updateNode: (uid: string, patch: Partial<EditorNode>) => void
  removeNode: (uid: string) => void
  moveNode: (dragUid: string, targetUid: string, position: DropPosition) => void
  toggleCollapsed: (uid: string) => void

  addPdfs: () => Promise<void>
  addPdfFolder: () => Promise<void>
  importReferences: () => Promise<void>
  /** The reviewer has looked at this row; drop its "just added" highlight. */
  confirmAdded: (uid: string) => void
  updatePaper: (uid: string, patch: Partial<EditorPaper>) => void
  removePaper: (uid: string) => void
  movePaper: (dragUid: string, targetUid: string, position: 'before' | 'after') => void

  /**
   * Create a new annotation project from a screening project's included
   * papers: pick the screening JSON, then open the pre-commit summary
   * (`screeningImport`) before anything is written.
   */
  startFromScreening: () => Promise<void>
  /** The papers-only half of the above, for an editor session already open. */
  importFromScreening: () => Promise<void>
  /** Answer the pre-commit import summary opened by either action above. */
  resolveScreeningImport: (choice: 'include-undecided' | 'skip-undecided' | 'cancel') => Promise<void>

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
    aiEnabled: s.aiEnabled,
    reviewers: s.reviewers,
    screening: s.screening,
    extra: s.extra,
  }
}

function applySnapshot(s: EditorState, snap: EditorSnapshot): void {
  s.nodes = snap.nodes
  s.papers = snap.papers
  s.location = snap.location
  s.version = snap.version
  s.title = snap.title
  s.aiEnabled = snap.aiEnabled
  s.reviewers = snap.reviewers
  s.screening = snap.screening
  s.extra = snap.extra
}

/** Push a pre-mutation snapshot onto the undo stack and drop the redo stack. */
function pushPast(s: EditorState, snap: EditorSnapshot): void {
  s.past.push(snap)
  if (s.past.length > HISTORY_LIMIT) s.past.shift()
  s.future = []
}

/** The editor fields an opened project populates, before it is committed to state. */
interface OpenedEditorState {
  location: ProjectLocation
  version: number
  title: string
  aiEnabled: boolean
  reviewers: number
  screening: ScreeningConfig | null
  reviewerIdentities: Record<string, ReviewerIdentity>
  extra: Record<string, unknown>
  nodes: EditorNode[]
  papers: EditorPaper[]
}

/**
 * Parse an opened project into the editor's draft shape. Throws on invalid JSON
 * or a structure the loader rejects, so callers can show a friendly error. This
 * is shared by "Edit annotation JSON…" (file picker) and the per-recent pen.
 */
export function editorStateFromOpened(opened: OpenedProject): OpenedEditorState {
  const data = JSON.parse(opened.text) as Record<string, unknown>
  const parsed = projectSchema.parse(data)
  // Trimmed/deduped the same way `project.ts`'s loader treats it — a broken
  // reasons list is still worth surfacing in the reasons editor rather than
  // failing to open, since the editor's whole job is letting it be fixed.
  const screening: ScreeningConfig | null = parsed.config.screening
    ? { reasons: dedupeTrim(parsed.config.screening.reasons) }
    : null
  const papers: EditorPaper[] = parsed.papers.map((p) => {
    const known = new Set([
      'id',
      'title',
      'authors',
      'doi',
      'abstract',
      'abstractFromPdf',
      'pdf',
      'annotations',
    ])
    const extra: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(p)) if (!known.has(k)) extra[k] = v
    return {
      uid: nextUid(),
      id: p.id,
      title: p.title,
      authors: (p.authors ?? []).join(', '),
      doi: p.doi ?? '',
      abstract: p.abstract ?? '',
      abstractFromPdf: p.abstract && p.abstractFromPdf === true ? true : undefined,
      pdf: p.pdf,
      // No absolute source: the file already stores a relative path, and we only
      // re-derive paths for PDFs the user adds in this session.
      sourcePath: undefined,
      annotations: p.annotations ?? {},
      extra,
    }
  })
  const rootExtra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (!['version', 'title', 'config', 'papers'].includes(k)) rootExtra[k] = v
  }
  return {
    location: { handle: opened.handle, name: opened.name, path: opened.handle.path },
    version: parsed.version ?? 1,
    title: parsed.title ?? '',
    // Absent means enabled; only an explicit `false` opts out.
    aiEnabled: parsed.config.ai !== false,
    // Absent or 1 means single-reviewer, same default as project.ts's loader.
    reviewers: parsed.config.reviewers ?? 1,
    screening,
    reviewerIdentities: parseReviewerIdentities(
      (parsed.config as { reviewerIdentities?: unknown }).reviewerIdentities,
    ),
    extra: rootExtra,
    // A screening project's schema is derived, not authored, so there is
    // nothing for the schema-builder tree to hold — see `ProjectEditor.tsx`,
    // which renders `ScreeningReasonsEditor` instead whenever `screening` is set.
    nodes: screening ? [] : fromAnnotationDefs(parsed.config.schema ?? []),
    papers,
  }
}

/** Trim, drop blanks, and dedupe (first-seen order) — the same rule
 *  `project.ts`'s `parseScreening` applies on load. */
function dedupeTrim(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const v = raw.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out.length > 0 ? out : [...DEFAULT_SCREENING_REASONS]
}

/** Commit a parsed project into the editor as a fresh "edit" session. */
function openEditorSession(s: EditorState, st: OpenedEditorState): void {
  s.open = true
  s.mode = 'edit'
  s.location = st.location
  s.version = st.version
  s.title = st.title
  s.aiEnabled = st.aiEnabled
  s.reviewers = st.reviewers
  s.screening = st.screening
  s.reviewerIdentities = st.reviewerIdentities
  s.extra = st.extra
  s.nodes = st.nodes
  s.papers = st.papers
  s.dirty = false
  s.busy = false
  s.error = null
  s.issues = []
  s.notice = null
  s.extracting = 0
  s.justAdded = {}
  s.past = []
  s.future = []
  s.screeningImport = null
}

/** Map a load failure to the editor's error shape. */
function openError(err: unknown): EditorError {
  const details =
    err instanceof z.ZodError
      ? err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      : [String(err)]
  return { message: 'That file could not be opened for editing.', details }
}

export const useEditorStore = create<EditorState>()(
  immer((set, get) => {
    /**
     * Shared by `addPdfs` and `addPdfFolder` — they differ only in how the
     * PDFs are picked. Skips PDFs the project already references, creates a
     * row per new one with a name-derived placeholder, marks each "just
     * added", then reads title/authors from each in the background without
     * clobbering anything the user typed while that read was in flight.
     */
    const addPickedPdfs = async (picked: PickedPdf[]) => {
      if (picked.length === 0) return
      const platform = getPlatform()
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
          s.justAdded[paper.uid] = true
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
              if (meta.abstract && !paper.abstract.trim()) {
                paper.abstract = meta.abstract
                paper.abstractFromPdf = true
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
    }

    return {
    open: false,
    mode: 'new',
    location: null,
    version: 1,
    title: '',
    aiEnabled: true,
    reviewers: 1,
    screening: null,
    reviewerIdentities: {},
    extra: {},
    nodes: [],
    papers: [],
    dirty: false,
    busy: false,
    error: null,
    issues: [],
    notice: null,
    extracting: 0,
    justAdded: {},
    past: [],
    future: [],
    screeningImport: null,

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
        s.aiEnabled = true
        s.reviewers = 1
        s.screening = null
        s.extra = {}
        s.nodes = [makeNode()]
        s.papers = []
        s.dirty = false
        s.busy = false
        s.error = null
        s.issues = []
        s.notice = null
        s.extracting = 0
        s.justAdded = {}
        s.past = []
        s.future = []
        s.screeningImport = null
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
        const st = editorStateFromOpened(opened)
        set((s) => openEditorSession(s, st))
      } catch (err) {
        set((s) => {
          s.busy = false
          s.error = openError(err)
        })
      }
    },

    startEditRecent: async (id) => {
      const platform = getPlatform()
      set((s) => {
        s.busy = true
      })
      let opened: OpenedProject | null
      try {
        opened = await platform.openRecent(id)
      } catch (err) {
        set((s) => {
          s.busy = false
          s.error = openError(err)
        })
        return
      }
      if (!opened) {
        // The file is gone. The editor never opens; instead grey the entry (the
        // drive may come back) and surface the error on the welcome screen, exactly
        // as store.openRecent does for the annotate path.
        set((s) => {
          s.busy = false
        })
        const cur = useStore.getState()
        useStore.setState({
          recents: cur.recents.map((r) => (r.id === id ? { ...r, available: false } : r)),
          loadError: {
            message: 'That project could not be opened.',
            details: ['It may have been moved, renamed, or deleted.'],
          },
        })
        return
      }
      try {
        const st = editorStateFromOpened(opened)
        set((s) => openEditorSession(s, st))
      } catch (err) {
        set((s) => {
          s.busy = false
          s.error = openError(err)
        })
      }
    },

    close: () =>
      set((s) => {
        s.open = false
        s.error = null
        s.issues = []
        s.notice = null
        s.justAdded = {}
        // The draft is gone, so there is nothing left to save. Leaving this set
        // made Electron's quit guard — which prompts when *either* store is
        // dirty (`useElectronCloseGuard`) — go on claiming unsaved changes for
        // a draft the user had already chosen to discard. The next `startNew`/
        // `startEdit` rebuilds the draft from scratch anyway, so nothing here
        // is worth carrying across a close.
        s.dirty = false
        s.past = []
        s.future = []
        s.screeningImport = null
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

    setAiEnabled: (enabled) => {
      // A single toggle, so it is its own undo step (no coalescing).
      lastEditKey = null
      const snap = snapshotOf(get())
      set((s) => {
        pushPast(s, snap)
        s.aiEnabled = enabled
        s.dirty = true
      })
    },

    setReviewers: (n) => {
      const clamped = Math.max(1, Math.min(10, Math.round(n)))
      lastEditKey = null
      const snap = snapshotOf(get())
      set((s) => {
        pushPast(s, snap)
        s.reviewers = clamped
        s.dirty = true
      })
    },

    setScreening: (on) => {
      // A single toggle, so it is its own undo step (no coalescing) — same
      // shape as `setAiEnabled`.
      lastEditKey = null
      const snap = snapshotOf(get())
      set((s) => {
        pushPast(s, snap)
        s.screening = on ? { reasons: [...DEFAULT_SCREENING_REASONS] } : null
        s.dirty = true
      })
    },

    setScreeningReasons: (reasons) => {
      lastEditKey = null
      const snap = snapshotOf(get())
      set((s) => {
        if (!s.screening) return
        pushPast(s, snap)
        s.screening.reasons = reasons
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
      await addPickedPdfs(await getPlatform().pickPdfs())
    },

    addPdfFolder: async () => {
      await addPickedPdfs(await getPlatform().pickPdfFolder())
    },

    importReferences: async () => {
      const picked = await getPlatform().pickReferenceFile()
      if (!picked) return
      const entries = parseReferences(picked.text, picked.name)
      if (entries.length === 0) {
        set((s) => {
          s.notice = `No references could be read from ${picked.name}.`
        })
        return
      }

      const snap = snapshotOf(get())
      lastEditKey = null
      let updated = 0
      let unchanged = 0

      set((s) => {
        pushPast(s, snap)
        const ids = new Set(s.papers.map((p) => p.id))
        for (const entry of entries) {
          const match = findMatchingPaper(s.papers, entry)
          if (match) {
            if (fillFromRef(match, entry)) updated++
            else unchanged++
            continue
          }
          const paper = makePaperFromRef(entry, ids)
          ids.add(paper.id)
          s.papers.push(paper)
          s.justAdded[paper.uid] = true
        }
        if (updated > 0 || entries.length > updated + unchanged) s.dirty = true
        s.notice = summarizeImport(entries.length, updated, unchanged)
      })
    },

    confirmAdded: (uid) => {
      // Focusing a row that was never marked is the common case (every field
      // focus in an untouched paper list calls this) — don't churn the store
      // for a mark that isn't there.
      if (!get().justAdded[uid]) return
      set((s) => {
        delete s.justAdded[uid]
      })
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

    startFromScreening: async () => {
      set((s) => {
        s.busy = true
      })
      const picked = await pickScreeningProject(set)
      if (!picked) {
        set((s) => {
          s.busy = false
        })
        return
      }
      const { project, opened } = picked
      const partition = partitionScreeningPapers(project)
      set((s) => {
        s.busy = false
        s.screeningImport = {
          target: 'start',
          sourceHandle: opened.handle,
          sourceName: opened.name,
          screening: project.screening!,
          ...partition,
          pendingUnanimousCount: pendingUnanimous(project),
          multiReviewer: project.reviewers > 1,
        }
      })
    },

    importFromScreening: async () => {
      // Importing screening papers into a screening project is nonsense: a
      // screening project has no annotation fields of its own to carry them
      // into. The papers editor hides the button too — see PapersEditor.tsx.
      if (get().screening !== null) return
      set((s) => {
        s.busy = true
      })
      const picked = await pickScreeningProject(set)
      if (!picked) {
        set((s) => {
          s.busy = false
        })
        return
      }
      const { project, opened } = picked
      const partition = partitionScreeningPapers(project)
      set((s) => {
        s.busy = false
        s.screeningImport = {
          target: 'import',
          sourceHandle: opened.handle,
          sourceName: opened.name,
          screening: project.screening!,
          ...partition,
          pendingUnanimousCount: pendingUnanimous(project),
          multiReviewer: project.reviewers > 1,
        }
      })
    },

    resolveScreeningImport: async (choice) => {
      const draft = get().screeningImport
      if (!draft) return
      if (choice === 'cancel') {
        set((s) => {
          s.screeningImport = null
        })
        return
      }
      // Carried by default — dropping an undecided paper silently removes it
      // from a systematic review, which is unacceptable; the reviewer opts
      // out explicitly instead. Only an explicit `Decision: 'Exclude'` ever
      // drops a paper here.
      const carried =
        choice === 'include-undecided' ? [...draft.included, ...draft.undecided] : draft.included

      set((s) => {
        s.busy = true
      })
      const platform = getPlatform()

      // The new project's default save location is next to the screening
      // JSON: a sibling shares its directory, so every carried paper's
      // relative `pdf` still resolves without being rewritten at all.
      let location: ProjectLocation | null = null
      if (draft.target === 'start') {
        const baseName = (draft.sourceHandle.path ?? draft.sourceName).split(/[\\/]/).pop() ?? draft.sourceName
        const suggested = `${baseName.replace(/\.json$/i, '')}-annotation.json`
        location = await platform.siblingProjectLocation(draft.sourceHandle, suggested)
        if (!location) location = await platform.pickProjectLocation(suggested)
        if (!location) {
          set((s) => {
            s.busy = false
          })
          return
        }
      }

      // Each carried row needs a real absolute source, not just the relative
      // path the screening file stored — otherwise the moment the reviewer
      // uses "Change…" on the new project, `changeLocation` (which only
      // re-derives `pdf` for rows with a `sourcePath`) would silently leave
      // every PDF pointing at nothing.
      const absolutes = await platform.absolutePdfPaths(carried.map((p) => p.pdf), draft.sourceHandle)
      lastEditKey = null
      const importSnap = snapshotOf(get())

      set((s) => {
        s.busy = false
        const rows: EditorPaper[] = carried.map((p, i) => ({
          uid: nextUid(),
          id: p.id,
          title: p.title,
          authors: p.authors.join(', '),
          doi: p.doi ?? '',
          abstract: p.abstract ?? '',
          abstractFromPdf: p.abstract && p.abstractFromPdf ? true : undefined,
          pdf: p.pdf,
          sourcePath: p.pdf ? absolutes[i] : undefined,
          annotations: {},
        }))

        if (draft.target === 'start') {
          if (!location) return
          s.open = true
          s.mode = 'new'
          s.location = location
          s.version = 1
          s.title = ''
          s.aiEnabled = true
          s.reviewers = 1
          s.screening = null
          s.extra = {}
          s.nodes = [makeNode()]
          s.papers = rows
          s.dirty = true
          s.error = null
          s.issues = []
          s.notice = `Imported ${rows.length} paper${rows.length === 1 ? '' : 's'} from ${draft.sourceName}.`
          s.extracting = 0
          s.justAdded = Object.fromEntries(rows.map((r) => [r.uid, true as const]))
          s.past = []
          s.future = []
        } else {
          // Adding into an editor session already open: one undo step for the
          // whole import (only when it actually adds something), and a paper
          // already in the project (by DOI, then normalized title — same
          // rule `importReferences` uses) is skipped rather than duplicated.
          const existingIds = new Set(s.papers.map((p) => p.id))
          const toAdd: EditorPaper[] = []
          let skipped = 0
          for (const row of rows) {
            const match = findMatchingPaper(s.papers, { title: row.title, authors: [], doi: row.doi })
            if (match) {
              skipped++
              continue
            }
            let id = row.id
            let n = 2
            while (existingIds.has(id)) id = `${row.id}-${n++}`
            existingIds.add(id)
            row.id = id
            toAdd.push(row)
          }
          if (toAdd.length > 0) {
            pushPast(s, importSnap)
            for (const row of toAdd) {
              s.papers.push(row)
              s.justAdded[row.uid] = true
            }
            s.dirty = true
          }
          s.notice =
            `Imported ${toAdd.length} paper${toAdd.length === 1 ? '' : 's'} from ${draft.sourceName}` +
            (skipped > 0 ? ` (${skipped} already in the project, skipped).` : '.')
        }

        s.screeningImport = null
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
          s.justAdded = {}
        })
        // The project's title may have just changed, and the recents list shows
        // it — re-read so closing the editor doesn't reveal the old one.
        void useStore.getState().refreshRecents()
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
    }
  }),
)
