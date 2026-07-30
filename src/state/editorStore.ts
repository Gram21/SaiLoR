import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { z } from 'zod'
import {
  projectSchema,
  resolveSchema,
  SchemaError,
  type AnnotationDef,
  type FieldType,
  type ScreeningConfig,
} from '../model/schema'
import { extractPdfMeta } from '../model/pdfMeta'
import { parseReferences, pdfHintFileName, type RefEntry } from '../model/references'
import {
  loadProject,
  parseProvenance,
  parseProtocol,
  parseSchemaInfo,
  KNOWN_ROOT_KEYS,
  type Project,
  type ProjectProvenance,
  type ProjectProtocol,
} from '../model/project'
import { classifyImport, type DupRecord, type DupVerdict } from '../model/duplicates'
import { parseYear } from '../model/year'
import { getPlatform, type OpenedProject, type PickedPdf, type ProjectLocation, type SaveHandle } from '../platform'
import { DEFAULT_SCREENING_REASONS, screeningSchemaDefs } from '../screening/schema'
import { screeningReason, screeningStatus } from '../screening/status'
import { pendingUnanimousDecisions } from '../screening/counts'
import { renameReasonInPapers } from '../screening/reasonUsage'
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

/** A schema node in the editor. `group` means "no `type`" — a name-only
 *  sub-tree. The rest is exactly `FieldType`, imported rather than
 *  re-spelled, so this cannot silently drift from the set of types the model
 *  layer actually understands. */
export type EditorNodeKind = 'group' | FieldType

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
  /** Name of a sibling field gating this node's visibility, or '' for "always
   *  visible" — see `AnnotationDef.visibleIf`. */
  visibleIf: string
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
  /** Free text in the editor, exactly like every other paper field here —
   *  parsed to `Paper.year`'s number (or dropped) at `buildProjectJson`,
   *  the same boundary `doi`'s trimming crosses. Never stored as a number in
   *  the editor: a mid-typed "202" would otherwise have to round-trip through
   *  a numeric input's own ideas about what a partial number looks like. */
  year: string
  /** See `Paper.venue`. */
  venue: string
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
  provenance: ProjectProvenance | null
  protocol: ProjectProtocol | null
  schemaInfo: string | null
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
    visibleIf: '',
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
    // Never written for a boolean: it is a no-op there (a checkbox is never
    // empty), so the editor neither offers it nor emits it — matching
    // `resolveSchema`, which drops it on load for the same reason.
    if (n.kind !== 'group' && n.kind !== 'boolean' && n.required) def.required = true
    const vis = n.visibleIf.trim()
    if (vis) def.visibleIf = vis
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
    visibleIf: d.visibleIf ?? '',
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

export function findNode(nodes: EditorNode[], uid: string): EditorNode | null {
  for (const n of nodes) {
    if (n.uid === uid) return n
    const found = findNode(n.children, uid)
    if (found) return found
  }
  return null
}

/**
 * The names from the schema root down to `uid`, which is the path answers are
 * stored under — or null if the uid is not in the tree.
 */
export function nodePathNames(nodes: EditorNode[], uid: string): string[] | null {
  for (const n of nodes) {
    if (n.uid === uid) return [n.name]
    const below = nodePathNames(n.children, uid)
    if (below) return [n.name, ...below]
  }
  return null
}

/**
 * The uid of `uid`'s parent, or null when it sits at the root. Used to tell a
 * reorder (same parent, answers unaffected) from a re-parenting (the node's
 * answer path changes, and every answer under the old one is orphaned).
 */
export function parentUidOf(nodes: EditorNode[], uid: string, parent: string | null = null): string | null | undefined {
  for (const n of nodes) {
    if (n.uid === uid) return parent
    const below = parentUidOf(n.children, uid, n.uid)
    if (below !== undefined) return below
  }
  return undefined
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
    year: '',
    venue: '',
    abstract: '',
    pdf: relativePath,
    sourcePath,
    annotations: {},
  }
}

// ---------------------------------------------------------------------------
// Importing references (BibTeX / RIS / CSL-JSON)
// ---------------------------------------------------------------------------

/** The same split `buildProjectJson` uses to turn the editable comma-joined
 *  field back into a list — one implementation, so a duplicate-detection
 *  adapter and the save path never quietly disagree on what an author list is. */
function splitAuthors(authors: string): string[] {
  return authors
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
}

function paperToDupRecord(p: EditorPaper): DupRecord {
  return {
    title: p.title,
    authors: splitAuthors(p.authors),
    doi: p.doi || undefined,
    // `EditorPaper.year` is the editor's free-text string; `parseYear` gives
    // the number `duplicates.ts`'s year-gap veto needs, or `undefined` (which
    // the veto reads as "no year, don't veto"). Supplying it on *both* sides
    // is what lets a same-title/different-year pair be told apart — before
    // `EditorPaper` had a year, only the incoming reference carried one and
    // the veto could never fire against an existing paper.
    year: parseYear(p.year),
  }
}

function refToDupRecord(entry: RefEntry): DupRecord {
  return { title: entry.title, authors: entry.authors, doi: entry.doi, year: entry.year }
}

/**
 * The existing paper a parsed reference *certainly* refers to, if any — DOI or
 * an exact normalized title, the same two signals this always used. A merely
 * *probable* match (see `classifyImport`) is deliberately not a match here:
 * this function's callers either fill fields into what it returns or skip the
 * row outright, and neither of those is safe to do on a guess. A thin adapter
 * over `classifyImport` rather than its own comparison, so there is exactly
 * one place that decides what "the same paper" means.
 */
export function findMatchingPaper(papers: EditorPaper[], entry: RefEntry): EditorPaper | undefined {
  const verdict = classifyImport(papers.map(paperToDupRecord), [refToDupRecord(entry)])[0]
  if (verdict.kind !== 'certain' || verdict.target.where !== 'existing') return undefined
  return papers[verdict.target.index]
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
    year: entry.year !== undefined ? String(entry.year) : '',
    venue: entry.venue ?? '',
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
  if (!match.year.trim() && entry.year !== undefined) {
    match.year = String(entry.year)
    changed = true
  }
  if (!match.venue.trim() && entry.venue) {
    match.venue = entry.venue
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

/** `'merge'` fills `entry` into whatever paper the verdict points at (never
 *  overwriting, via `fillFromRef`); `'separate'` adds it as its own row even
 *  though something looked like a match for it. */
export type DuplicateDecision = 'merge' | 'separate'

/**
 * A batch of parsed references that `classifyImport` found at least one
 * *probable* duplicate in, waiting on the reviewer's per-pair decision before
 * anything is written — the same "nothing committed until a choice is made"
 * shape `ScreeningImportDraft` uses. `certain`/`new` entries in `verdicts`
 * need no decision; only a `'probable'` entry is ever read from `decisions`.
 */
export interface DuplicateReviewDraft {
  sourceName: string
  entries: RefEntry[]
  /** Index-aligned with `entries`, straight from `classifyImport`. */
  verdicts: DupVerdict[]
  /** `existingUids[j]` is the `uid` `classifyImport`'s `{ where: 'existing',
   *  index: j }` refers to — a snapshot taken at classification time, since a
   *  verdict's index is only meaningful against the papers array as it stood
   *  then. */
  existingUids: string[]
  /** Keyed by entry index; absent means "not decided yet". */
  decisions: Record<number, DuplicateDecision>
}

/**
 * Commit a parsed batch into `s.papers`, in index order, per verdict and (for
 * a `'probable'` verdict) the reviewer's decision.
 *
 * Index order matters beyond readability: a `{ where: 'batch', index }`
 * target always points at an *earlier* entry (see `classifyImport`'s doc
 * comment), so by the time entry `i` is processed, `resolvedUid[target.index]`
 * has already been set — whether that earlier entry became a new row or was
 * itself merged into an existing one. A batch target therefore always
 * resolves to wherever its own match actually landed, however many links long
 * the chain is, without needing a union-find to get there.
 */
function commitImport(
  s: EditorState,
  entries: RefEntry[],
  verdicts: DupVerdict[],
  decisions: Record<number, DuplicateDecision>,
  existingUids: string[],
): { updated: number; unchanged: number; added: number } {
  const ids = new Set(s.papers.map((p) => p.id))
  const resolvedUid: string[] = []
  let updated = 0
  let unchanged = 0
  let added = 0

  entries.forEach((entry, i) => {
    const verdict = verdicts[i]
    const shouldMerge = verdict.kind === 'certain' || (verdict.kind === 'probable' && decisions[i] === 'merge')

    if (shouldMerge && (verdict.kind === 'certain' || verdict.kind === 'probable')) {
      const targetUid =
        verdict.target.where === 'existing' ? existingUids[verdict.target.index] : resolvedUid[verdict.target.index]
      const match = targetUid ? s.papers.find((p) => p.uid === targetUid) : undefined
      if (match) {
        if (fillFromRef(match, entry)) updated++
        else unchanged++
        resolvedUid[i] = match.uid
        return
      }
      // The target vanished (shouldn't happen — nothing removes a paper mid-import)
      // — fall through and add it as its own row rather than silently dropping it.
    }

    const paper = makePaperFromRef(entry, ids)
    ids.add(paper.id)
    s.papers.push(paper)
    s.justAdded[paper.uid] = true
    resolvedUid[i] = paper.uid
    added++
  })

  return { updated, unchanged, added }
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
  /** Optional for the same reason `screening?` is above. Absent/null means
   *  "not imported from another project" — the overwhelmingly common case. */
  provenance?: ProjectProvenance | null
  /** Optional for the same reason. Absent/null means no authored protocol. */
  protocol?: ProjectProtocol | null
  /** Optional for the same reason. Absent/null means no schema comment. */
  schemaInfo?: string | null
  extra: Record<string, unknown>
  nodes: EditorNode[]
  papers: EditorPaper[]
}): Record<string, unknown> {
  const title = state.title?.trim()
  const screening = state.screening ?? null
  return {
    ...state.extra,
    version: state.version,
    // Omitted when blank, so the app falls back to the file name.
    ...(title ? { title } : {}),
    ...(state.provenance ? { provenance: state.provenance } : {}),
    ...(state.protocol ? { protocol: state.protocol } : {}),
    ...(state.schemaInfo ? { schemaInfo: state.schemaInfo } : {}),
    // `ai` is only written when disabled, and `reviewers` only when it says
    // more than the single-reviewer default — matching serializeProject.
    config: {
      // A screening draft's schema is the derived projection of its reasons,
      // never the (empty) authored node list — see `Project.screening`.
      schema: screening ? screeningSchemaDefs(screening) : toAnnotationDefs(state.nodes),
      ...(state.aiEnabled ? {} : { ai: false }),
      ...(state.reviewers > 1 ? { reviewers: state.reviewers } : {}),
      ...(screening ? { screening: { reasons: screening.reasons } } : {}),
    },
    papers: state.papers.map((p) => {
      const out: Record<string, unknown> = { ...(p.extra ?? {}) }
      out.id = p.id.trim()
      out.title = p.title.trim()
      out.authors = splitAuthors(p.authors)
      // `buildProjectJson` is a second serializer (it does not go through
      // `serializeProject`), so the string→number boundary for `year` lives
      // here, symmetric with the number→string one in `editorStateFromOpened`.
      const y = parseYear(p.year)
      if (y !== undefined) out.year = y
      if (p.venue.trim()) out.venue = p.venue.trim()
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
  year?: number
  venue?: string
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
  /** Which kind of project `target: 'start'` creates. Meaningless when
   *  `target === 'import'` — the open project's kind is already fixed by the
   *  session that is already open. */
  startKind: 'annotation' | 'screening'
  sourceHandle: SaveHandle
  sourceName: string
  /** The source project's own `title`, when it set one — not its file name. */
  sourceTitle?: string
  /** The source's own reasons. Seeds a `startKind: 'screening'` target's own
   *  (separately editable) reason list — see `resolveScreeningImport`. */
  screening: ScreeningConfig
  /** Not excluded — `Decision === 'Include'`. Always carried. */
  included: ScreeningImportRow[]
  /** No decision recorded (or an unrecognised one) — carried unless the
   *  reviewer explicitly leaves them out. */
  undecided: ScreeningImportRow[]
  excludedCount: number
  /** Reason → how many excluded papers cited it, for the summary. */
  excludedByReason: Record<string, number>
  /** Papers still undecided that every reviewer decided identically, which
   *  Consolidation had not adopted at the time this was read — see
   *  `screening/counts.ts`'s `pendingUnanimousDecisions`. Decisions only,
   *  because the dialog showing this promises adopting would change the
   *  inclusion counts. Only ever nonzero when `reviewers > 1`. */
  pendingUnanimousCount: number
  /** The source's seat count. Not a `multiReviewer` boolean: a `startKind:
   *  'screening'` target inherits this number outright (see
   *  `resolveScreeningImport`), and one fact must not be stored two ways. */
  reviewers: number
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
  // Null-prototype — see `screening/counts.ts`. On a plain object a reason of
  // "constructor" tallied onto a function ("function Object() {...}1" in the
  // import dialog) and "__proto__" hit the prototype setter, dropping the row.
  const excludedByReason: Record<string, number> = Object.create(null)

  for (const p of project.papers) {
    const status = screeningStatus(p.annotations)
    const row: ScreeningImportRow = {
      id: p.id,
      title: p.title,
      authors: p.authors,
      doi: p.doi,
      year: p.year,
      venue: p.venue,
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
  extra: Record<string, unknown>
  /** Set when this project's papers were imported from another project (see
   *  `resolveScreeningImport`); null for one started from scratch. Never
   *  edited directly in the UI — a durable record, not a setting. */
  provenance: ProjectProvenance | null
  /** The review's authored protocol, or null. Unlike `provenance`, this one
   *  *is* edited in the UI (`ProjectEditor`'s protocol section). */
  protocol: ProjectProtocol | null
  /** Free-text "about this schema" note, or null. Edited in the UI alongside
   *  the schema tree; shown to reviewers via `AnnotationPanel`'s info button. */
  schemaInfo: string | null
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
  /**
   * Set by `importReferences` whenever `classifyImport` found at least one
   * *probable* duplicate in the batch — nothing from that import has been
   * committed yet. Session-only, same reasoning as `screeningImport`: nothing
   * in here has touched the draft, so there is nothing for undo to know about.
   */
  duplicateReview: DuplicateReviewDraft | null

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
  /** Rewrite an exclusion reason across every paper that recorded it (see
   *  `renameReasonInPapers`) — offered by `ScreeningReasonsEditor` when a
   *  rename would otherwise orphan existing decisions. Its own undo step. */
  migrateScreeningReason: (from: string, to: string) => void
  /** Replace the whole authored protocol (the editor assembles it from its
   *  fields). Pass `null` to clear it. Coalesced like `setTitle` so a burst of
   *  typing is one undo step. */
  setProtocol: (protocol: ProjectProtocol | null) => void
  /** Replace the schema-wide info comment. Pass `null` to clear it. Coalesced
   *  like `setProtocol` so a burst of typing is one undo step. */
  setSchemaInfo: (schemaInfo: string | null) => void

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
   * Create a new project — annotation or screening, the reviewer's choice —
   * from a screening project's included papers: pick the screening JSON,
   * then open the pre-commit summary (`screeningImport`) before anything is
   * written.
   */
  startFromScreening: () => Promise<void>
  /** The papers-only half of the above, for an editor session already open. */
  importFromScreening: () => Promise<void>
  /** Choose what `target: 'start'` builds. A no-op when there is no pending
   *  import, or it targets an already-open session. Not undoable — the draft
   *  is session-only, same as the rest of `screeningImport`. */
  setScreeningImportKind: (kind: 'annotation' | 'screening') => void
  /** Answer the pre-commit import summary opened by either action above. */
  resolveScreeningImport: (choice: 'include-undecided' | 'skip-undecided' | 'cancel') => Promise<void>

  /** Decide one probable-duplicate row in the open `duplicateReview`. A no-op
   *  if there is no open review, or the row isn't `'probable'`. */
  setDuplicateDecision: (entryIndex: number, decision: DuplicateDecision) => void
  /** Decide every still-open `'probable'` row at once. */
  setAllDuplicateDecisions: (decision: DuplicateDecision) => void
  /** `'apply'` commits the batch (every `'probable'` row must be decided
   *  first — see `DuplicateReviewDialog`); `'cancel'` discards the whole
   *  import, undecided rows included. Synchronous: nothing here reads a file
   *  or asks the platform for anything, `importReferences` already did that. */
  resolveDuplicateReview: (choice: 'apply' | 'cancel') => void

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
    provenance: s.provenance,
    protocol: s.protocol,
    schemaInfo: s.schemaInfo,
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
  s.provenance = snap.provenance
  s.protocol = snap.protocol
  s.schemaInfo = snap.schemaInfo
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
  extra: Record<string, unknown>
  provenance: ProjectProvenance | null
  protocol: ProjectProtocol | null
  schemaInfo: string | null
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
      'year',
      'venue',
      'abstract',
      'abstractFromPdf',
      'pdf',
      'annotations',
    ])
    const extra: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(p)) if (!known.has(k)) extra[k] = v
    // The same lenient repair `project.ts`'s loader applies to `year` — a
    // hand-edited `"2021"` string opens here exactly as it would in the
    // annotation view, rather than landing in `extra` because this map alone
    // stayed stricter.
    const year = parseYear(p.year)
    return {
      uid: nextUid(),
      id: p.id,
      title: p.title,
      authors: (p.authors ?? []).join(', '),
      doi: p.doi ?? '',
      year: year !== undefined ? String(year) : '',
      venue: p.venue ?? '',
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
  // `KNOWN_ROOT_KEYS` — not a second hand-maintained list — so a key this
  // editor now knows about (like `provenance`) can never end up both parsed
  // explicitly below *and* riding along in `extra`, which would make it look
  // "changed" on every git diff even when nothing about it did.
  const rootExtra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (!KNOWN_ROOT_KEYS.has(k)) rootExtra[k] = v
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
    extra: rootExtra,
    provenance: parseProvenance(data.provenance),
    protocol: parseProtocol(data.protocol),
    schemaInfo: parseSchemaInfo(data.schemaInfo),
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
  s.extra = st.extra
  s.provenance = st.provenance
  s.protocol = st.protocol
  s.schemaInfo = st.schemaInfo
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
  s.duplicateReview = null
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
    // Off by default while AI-assisted annotation itself has no reachable
    // entry point in the app (see `aiUnlocked` in store.ts) — there is no UI
    // here to turn it back on either (see ProjectEditor.tsx's own comment on
    // why the toggle is gone), so a new project written today should not
    // silently claim a feature nobody can use. `config.ai: false` is written
    // out just like an explicit opt-out would be — see serializeProject.
    aiEnabled: false,
    reviewers: 1,
    screening: null,
    extra: {},
    provenance: null,
    protocol: null,
    schemaInfo: null,
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
    duplicateReview: null,

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
        // See the initial-state comment above: no reachable feature, no UI to
        // turn it back on, so a new project starts opted out.
        s.aiEnabled = false
        s.reviewers = 1
        s.screening = null
        s.extra = {}
        s.provenance = null
        s.protocol = null
        s.schemaInfo = null
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
        s.duplicateReview = null
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
        s.duplicateReview = null
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
      // every path. Two mechanisms, because the papers differ in what we know
      // about them:
      //  - added in this session: we still hold the absolute source, so
      //    re-deriving from that is exact.
      //  - loaded from the opened file: `editorStateFromOpened` deliberately
      //    leaves `sourcePath` undefined, so there is no absolute source — but
      //    their `pdf` is relative to the *current* location, which is exactly
      //    what `rebasePdfPaths` re-anchors (the same call `store.ts`'s
      //    `saveAs` makes). Without this second pass, moving an opened project
      //    left every one of its PDFs pointing at nothing, silently.
      const papers = get().papers
      const withSource = papers.filter((p) => p.sourcePath)
      let rederived: string[] = []
      if (withSource.length > 0) {
        rederived = await platform.relativePdfPaths(
          withSource.map((p) => ({ name: p.pdf, path: p.sourcePath })),
          location,
        )
      }
      const withoutSource = papers.filter((p) => !p.sourcePath)
      let rebased: string[] = []
      if (withoutSource.length > 0 && current) {
        rebased = await platform.rebasePdfPaths(
          withoutSource.map((p) => p.pdf),
          current.handle,
          location.handle,
        )
      }
      const snap = snapshotOf(get())
      lastEditKey = null
      set((s) => {
        pushPast(s, snap)
        s.location = location
        let i = 0
        let j = 0
        for (const p of s.papers) {
          if (p.sourcePath) p.pdf = rederived[i++] ?? p.pdf
          else p.pdf = rebased[j++] ?? p.pdf
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

    setProtocol: (protocol) => {
      const key = 'project:protocol'
      const coalesce = key === lastEditKey
      lastEditKey = key
      const snap = snapshotOf(get())
      set((s) => {
        if (!coalesce) pushPast(s, snap)
        s.protocol = protocol
        s.dirty = true
      })
    },

    setSchemaInfo: (schemaInfo) => {
      const key = 'project:schemaInfo'
      const coalesce = key === lastEditKey
      lastEditKey = key
      const snap = snapshotOf(get())
      set((s) => {
        if (!coalesce) pushPast(s, snap)
        s.schemaInfo = schemaInfo
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

    migrateScreeningReason: (from, to) => {
      lastEditKey = null
      const snap = snapshotOf(get())
      set((s) => {
        const next = renameReasonInPapers(s.papers, from, to)
        // Nothing referenced the old reason after all — leave the draft (and
        // its undo stack) untouched rather than push a no-op step.
        if (next === s.papers || next.every((p, i) => p === s.papers[i])) return
        pushPast(s, snap)
        s.papers = next
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
        // A group holds no value, so it cannot be required; a boolean is never
        // empty, so `required` on one is a no-op (see `resolveSchema`). Both
        // are cleared here so switching a field to either type drops a stale
        // flag rather than carrying a meaningless one.
        if (node.kind === 'group' || node.kind === 'boolean') node.required = false
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

      // Classified *before* the mutating `set` below, against a plain read of
      // the current papers — `classifyImport` is pure and synchronous, so
      // nothing can change between this read and the `set` call it feeds.
      const papers = get().papers
      const existingUids = papers.map((p) => p.uid)
      const verdicts = classifyImport(papers.map(paperToDupRecord), entries.map(refToDupRecord))

      // A probable match is never silently merged and never silently added
      // twice — it has to go through the reviewer. `certain`/`new` entries need
      // no such thing, and demoting *every* import to a review dialog would
      // turn a routine re-import of an unchanged `.bib` into a wall of prompts.
      if (verdicts.some((v) => v.kind === 'probable')) {
        set((s) => {
          s.duplicateReview = { sourceName: picked.name, entries, verdicts, existingUids, decisions: {} }
        })
        return
      }

      const snap = snapshotOf(get())
      lastEditKey = null
      set((s) => {
        pushPast(s, snap)
        const { updated, unchanged, added } = commitImport(s, entries, verdicts, {}, existingUids)
        if (updated > 0 || added > 0) s.dirty = true
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
          // The existing button's long-standing output — deciding this
          // silently would undermine the one thing this dialog exists for:
          // making the choice explicit rather than automatic. The reviewer
          // opts into a second screening pass with the radio in the dialog.
          startKind: 'annotation',
          sourceHandle: opened.handle,
          sourceName: opened.name,
          sourceTitle: project.title,
          screening: project.screening!,
          ...partition,
          pendingUnanimousCount: pendingUnanimousDecisions(project),
          reviewers: project.reviewers,
        }
      })
    },

    importFromScreening: async () => {
      // In-place import *into* a screening project is not the "nonsense" it
      // once looked like: a carried row arrives with `annotations: {}`, i.e.
      // undecided under the open project's own reasons — perfectly
      // well-defined. It stays blocked anyway, for three reasons: unblocking
      // it means editing PapersEditor.tsx's own gate, which is not part of
      // this feature; the two-pass workflow this exists for is fully served
      // by `startFromScreening` (a *second*, independently reasoned
      // screening project); and "pool two independent screens into one" is a
      // distinct workflow with no demonstrated need yet.
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
          // Meaningless here — the open session's kind is already fixed —
          // but the field is not optional, so it needs a value.
          startKind: 'annotation',
          sourceHandle: opened.handle,
          sourceName: opened.name,
          sourceTitle: project.title,
          screening: project.screening!,
          ...partition,
          pendingUnanimousCount: pendingUnanimousDecisions(project),
          reviewers: project.reviewers,
        }
      })
    },

    setScreeningImportKind: (kind) =>
      set((s) => {
        if (s.screeningImport) s.screeningImport.startKind = kind
      }),

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
        // "-fulltext", not "-screening": the second screening pass in an SLR
        // *is* the full-text screen, and naming it for the workflow it serves
        // beats naming it for its data shape (which would read
        // "screening-screening.json" for the overwhelmingly common source
        // name). Only a suggestion — the save dialog lets the reviewer rename.
        const suffix = draft.startKind === 'screening' ? 'fulltext' : 'annotation'
        const suggested = `${baseName.replace(/\.json$/i, '')}-${suffix}.json`
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

      // Merging into an already-open session (`target !== 'start'`) drops the
      // carried papers into whatever directory that project already lives in
      // — almost certainly not the screening project's own directory, unlike
      // `target: 'start'` above, which defaults to a sibling of the source for
      // exactly this reason. Re-derive `pdf` against the open project's own
      // location first, the identical `relativePdfPaths` pattern
      // `changeLocation` uses for "Save as" — left verbatim, every one of
      // these paths would point at nothing the moment the reviewer looked.
      let rebased: string[] = []
      if (draft.target !== 'start') {
        const withSource = carried
          .map((p, i) => ({ name: p.pdf, path: absolutes[i] }))
          .filter((x): x is { name: string; path: string } => !!x.path)
        if (withSource.length > 0) {
          rebased = await platform.relativePdfPaths(withSource, get().location)
        }
      }

      lastEditKey = null
      const importSnap = snapshotOf(get())
      // Read once, outside the immer producer below, so the producer stays a
      // pure function of its inputs instead of reading the ambient clock itself.
      const importedAt = new Date().toISOString()

      set((s) => {
        s.busy = false
        let rebasedIdx = 0
        const rows: EditorPaper[] = carried.map((p, i) => {
          const hasSource = !!absolutes[i]
          // `target: 'start'` never rebases (correct by construction — see
          // above); `target: 'import'` uses the re-derived path whenever one
          // was computed, falling back to the verbatim value otherwise (no
          // source path at all, or the browser, which has no paths to rebase).
          const pdf = draft.target !== 'start' && hasSource ? (rebased[rebasedIdx++] ?? p.pdf) : p.pdf
          return {
            uid: nextUid(),
            id: p.id,
            title: p.title,
            authors: p.authors.join(', '),
            doi: p.doi ?? '',
            year: p.year !== undefined ? String(p.year) : '',
            venue: p.venue ?? '',
            abstract: p.abstract ?? '',
            abstractFromPdf: p.abstract && p.abstractFromPdf ? true : undefined,
            pdf,
            sourcePath: p.pdf ? absolutes[i] : undefined,
            annotations: {},
          }
        })

        if (draft.target === 'start') {
          if (!location) return
          const screeningTarget = draft.startKind === 'screening'
          s.open = true
          s.mode = 'new'
          s.location = location
          s.version = 1
          s.title = ''
          // See the initial-state comment near the top of this store: no
          // reachable AI feature, no UI to turn it back on, so a fresh
          // project — including one built from a screening import — starts
          // opted out.
          s.aiEnabled = false
          // A second screening pass repeats the same protocol step with the
          // same screening team, so its seat count is a property of the
          // protocol being continued — dual screening is a PRISMA-reportable
          // design property, and silently resetting it to one reviewer could
          // convert a dual-screened review into a single-screened one without
          // anyone noticing. Data extraction (the annotation target) is a
          // different phase with its own independent staffing decision, so it
          // keeps the existing single-reviewer default — deliberate, not an
          // oversight, and outside this feature's mandate to revisit.
          s.reviewers = screeningTarget ? draft.reviewers : 1
          // The source's own reasons seed the new list, not
          // DEFAULT_SCREENING_REASONS: they are the pre-registered protocol's
          // own vocabulary (already chosen once, by this same team), and
          // PRISMA reports exclusions per reason across both passes — a
          // disjoint generic list would make the two passes' numbers
          // un-poolable. Editable immediately in ScreeningReasonsEditor, same
          // as any other screening project's reasons.
          s.screening = screeningTarget ? { reasons: [...draft.screening.reasons] } : null
          s.extra = {}
          // A screening draft's schema is derived from `screening.reasons`,
          // not authored (see `Project.screening`), so there is nothing for
          // the schema-builder tree to hold — `editorStateFromOpened` uses
          // the same empty array for the same reason.
          s.nodes = screeningTarget ? [] : [makeNode()]
          s.papers = rows
          s.dirty = true
          s.error = null
          s.issues = []
          s.notice = `Imported ${rows.length} paper${rows.length === 1 ? '' : 's'} from ${draft.sourceName}.`
          s.extracting = 0
          s.justAdded = Object.fromEntries(rows.map((r) => [r.uid, true as const]))
          s.past = []
          s.future = []
          // Left for the reviewer to author in the new project rather than
          // carried from the source: the protocol *is* the same review across
          // both phases, so carrying it would be defensible, but the import
          // draft does not currently capture the source's protocol, and
          // threading it through is a separate change. A fresh project starts
          // with none, exactly as one started from scratch does.
          s.protocol = null
          s.schemaInfo = null
          s.provenance = {
            kind: 'screening-import',
            source: {
              file: draft.sourceName,
              ...(draft.sourceTitle ? { title: draft.sourceTitle } : {}),
            },
            importedAt,
            counts: {
              included: draft.included.length,
              undecided: draft.undecided.length,
              excluded: draft.excludedCount,
              carried: rows.length,
            },
          }
        } else {
          // Adding into an editor session already open: one undo step for the
          // whole import (only when it actually adds something), and a paper
          // already in the project (by DOI, then normalized title — same
          // rule `importReferences` uses) is skipped rather than duplicated.
          const existingIds = new Set(s.papers.map((p) => p.id))
          const toAdd: EditorPaper[] = []
          let skipped = 0
          for (const row of rows) {
            // The row's *whole* identity, not just its title and DOI. Passing
            // `authors: []` and no year discarded exactly the two signals that
            // tell same-titled papers apart: with no authors the disjoint-author
            // demotion cannot fire, and with no year the year-gap veto cannot
            // either. A screening project whose included paper merely shared a
            // title with something already in the editor was reported as
            // "already in the project, skipped" and silently dropped — its DOI,
            // year and screening decision with it. `importReferences` passes
            // full records and gets this right; this path is the same question
            // and must be asked the same way.
            const match = findMatchingPaper(s.papers, {
              title: row.title,
              authors: splitAuthors(row.authors),
              doi: row.doi,
              year: parseYear(row.year),
            })
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

    setDuplicateDecision: (entryIndex, decision) =>
      set((s) => {
        if (!s.duplicateReview) return
        if (s.duplicateReview.verdicts[entryIndex]?.kind !== 'probable') return
        s.duplicateReview.decisions[entryIndex] = decision
      }),

    setAllDuplicateDecisions: (decision) =>
      set((s) => {
        const draft = s.duplicateReview
        if (!draft) return
        draft.verdicts.forEach((v, i) => {
          if (v.kind === 'probable') draft.decisions[i] = decision
        })
      }),

    resolveDuplicateReview: (choice) => {
      const draft = get().duplicateReview
      if (!draft) return
      if (choice === 'cancel') {
        set((s) => {
          s.duplicateReview = null
        })
        return
      }

      const snap = snapshotOf(get())
      lastEditKey = null
      set((s) => {
        pushPast(s, snap)
        const { updated, unchanged, added } = commitImport(
          s,
          draft.entries,
          draft.verdicts,
          draft.decisions,
          draft.existingUids,
        )
        if (updated > 0 || added > 0) s.dirty = true
        s.notice = summarizeImport(draft.entries.length, updated, unchanged)
        s.duplicateReview = null
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
