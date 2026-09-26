import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { z } from 'zod'
import {
  projectSchema,
  resolveSchema,
  SchemaError,
  compactVisibleIf,
  gateOn,
  isConditionGroup,
  type AnnotationDef,
  type FieldType,
  type VisibleIfEntry,
  type VisibleIfSpec,
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
import { paperIdProblem, paperIdsCollide } from '../model/paperId'
import { parseYear } from '../model/year'
import { getPlatform, type OpenedProject, type PickedPdf, type ProjectLocation, type SaveHandle } from '../platform'
import { DEFAULT_SCREENING_REASONS, screeningSchemaDefs } from '../screening/schema'
import { screeningReason, screeningStatus } from '../screening/status'
import { pendingUnanimousDecisions } from '../screening/counts'
import { renameReasonInPapers } from '../screening/reasonUsage'
import { annotationsDirProblem, DEFAULT_ANNOTATIONS_DIR, defaultSplitDirName } from '../model/annotationsDir'
import {
  amendVersion,
  newSchemaVersionId,
  parseSchemaHistory,
  parseSchemaVersion,
  type SchemaHistoryEntry,
} from '../model/schemaVersion'
import { useStore } from './store'

/**
 * Draft state for the project editor: build or edit a project JSON before/
 * without annotating. Works on the *raw* JSON shape rather than the loaded
 * `Project`, so existing papers' `annotations` are preserved verbatim while
 * the schema is edited — they're normalized against it next time the project
 * is opened for annotating.
 */

/** A schema node in the editor. `group` means "no `type`" — a name-only
 *  sub-tree. The rest is `FieldType`, imported so it can't drift from the
 *  model layer's own set of types. */
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
  /** Gate on this node's visibility, or null for "always visible" — see
   *  `AnnotationDef.visibleIf`. Always the expanded spec form, even for a
   *  bare-name shorthand file; `toAnnotationDefs` compacts it back on save. */
  visibleIf: VisibleIfSpec | null
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
  /** Free text, parsed to `Paper.year`'s number (or dropped) at
   *  `buildProjectJson`. Never a number in the editor: a mid-typed "202"
   *  would otherwise fight a numeric input's own ideas about partial numbers. */
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
  /** True when `abstract` came from the PDF-text heuristic (`addPickedPdfs`)
   *  rather than a reference file or typing — see `Paper.abstractFromPdf`.
   *  Cleared once a reference import provides a real one (`fillFromRef`). */
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
  finishCheckbox: boolean
  reviewers: number
  screening: ScreeningConfig | null
  extra: Record<string, unknown>
  provenance: ProjectProvenance | null
  protocol: ProjectProtocol | null
  schemaInfo: string | null
}

const HISTORY_LIMIT = 100

/** Last edited field: lets consecutive edits to the same input collapse into
 *  one undo step instead of one per keystroke. Mirrors the annotation store. */
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
    visibleIf: null,
    children: [],
    collapsed: false,
  }
}

// ---------------------------------------------------------------------------
// Conversion between the editor tree and the on-disk AnnotationDef shape
// ---------------------------------------------------------------------------

/** Deep copy of a gate, so the editor's draft never aliases the parsed file's
 *  objects (immer freezes them, and the dialog edits in place). */
function cloneSpec(spec: VisibleIfSpec): VisibleIfSpec {
  return {
    mode: spec.mode,
    conditions: spec.conditions.map((entry) =>
      isConditionGroup(entry)
        ? cloneSpec(entry)
        : // `equals` copied too, not aliased — same reason as cloneSpec itself.
          { field: entry.field, ...(entry.equals ? { equals: [...entry.equals] } : {}) },
    ),
  }
}

/** Drop a gate that says nothing: blank field names, and the whole thing once
 *  no condition is left. Mirrors `resolveSchema`, which drops unresolvable
 *  conditions on load — this just keeps them out of the file to begin with. */
function cleanVisibleIf(spec: VisibleIfSpec | null): VisibleIfSpec | null {
  if (!spec) return null
  const conditions: VisibleIfEntry[] = []
  for (const entry of spec.conditions) {
    if (isConditionGroup(entry)) {
      // An empty nested group says nothing either — same rule, one level down.
      const nested = cleanVisibleIf(entry)
      if (nested) conditions.push(nested)
      continue
    }
    const field = entry.field.trim()
    if (field !== '') conditions.push({ ...entry, field })
  }
  return conditions.length > 0 ? { mode: spec.mode, conditions } : null
}

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
    // Never written for a boolean: a checkbox is never empty, so `required`
    // is a no-op there — matches `resolveSchema`, which drops it on load too.
    if (n.kind !== 'group' && n.kind !== 'boolean' && n.required) def.required = true
    const vis = cleanVisibleIf(n.visibleIf)
    if (vis) def.visibleIf = compactVisibleIf(vis)
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
    visibleIf:
      d.visibleIf === undefined
        ? null
        : typeof d.visibleIf === 'string'
          ? gateOn(d.visibleIf)
          : cloneSpec(d.visibleIf),
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

/** The uid of `uid`'s parent, or null at the root. Distinguishes a reorder
 *  (same parent) from a re-parenting (answer path changes, orphaning answers). */
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

/** Move a node in the tree. Rejects dropping a node into itself or its own
 *  subtree (that would detach the subtree from the root). Exported for tests. */
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

/** A node whose name path changed since the schema was last saved. */
export interface PendingSchemaMove {
  uid: string
  /** The name path its answers are stored under now. */
  from: string[]
  to: string[]
  /** Whether the answers can follow: not through a repeated group, where it
   *  is unclear which entry an answer would land in. */
  carried: boolean
  /** The reviewer chose to leave the answers hidden instead. */
  kept: boolean
}

function pathsByUid(
  nodes: EditorNode[],
  prefix: EditorNode[] = [],
  out = new Map<string, EditorNode[]>(),
): Map<string, EditorNode[]> {
  for (const n of nodes) {
    const chain = [...prefix, n]
    out.set(n.uid, chain)
    pathsByUid(n.children, chain, out)
  }
  return out
}

const startsWith = (path: string[], prefix: string[]) =>
  prefix.length <= path.length && prefix.every((p, i) => path[i] === p)

/**
 * The renames and moves between the schema as last saved and the draft, in
 * the order they apply (parents first, so a child's own move is expressed
 * after its parent's). A node the reviewer chose to leave behind takes its
 * descendants with it, and so does one whose answers cannot follow.
 */
export function pendingSchemaMoves(
  saved: EditorNode[],
  draft: EditorNode[],
  keepHidden: Record<string, true>,
): PendingSchemaMove[] {
  const before = pathsByUid(saved)
  const after = pathsByUid(draft)
  const out: PendingSchemaMove[] = []
  const applied: { from: string[]; to: string[] }[] = []
  const stuck: string[][] = []
  const uids = [...before.keys()].sort((a, b) => before.get(a)!.length - before.get(b)!.length)
  for (const uid of uids) {
    const oldChain = before.get(uid)!
    const newChain = after.get(uid)
    if (!newChain) continue
    const old = oldChain.map((n) => n.name)
    if (stuck.some((p) => startsWith(old, p))) continue
    const cur = applied.reduce(
      (path, m) => (startsWith(path, m.from) ? [...m.to, ...path.slice(m.from.length)] : path),
      old,
    )
    const to = newChain.map((n) => n.name)
    if (cur.length === to.length && cur.every((n, i) => n === to[i])) continue
    let c = 0
    while (c < cur.length - 1 && c < to.length - 1 && cur[c] === to[c]) c++
    const single = (chain: EditorNode[]) => chain.slice(c, -1).every((n) => n.max === 1)
    const carried = single(oldChain) && single(newChain)
    const kept = !!keepHidden[uid]
    out.push({ uid, from: cur, to, carried, kept })
    if (carried && !kept) applied.push({ from: cur, to })
    else stuck.push(old)
  }
  return out
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

/** Identity of a referenced PDF, for duplicate detection: the absolute path
 *  when we have one (Electron), else the stored relative path (browser has none). */
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

/** Same split `buildProjectJson` uses, so the duplicate-detection adapter and
 *  the save path never disagree on what an author list is. */
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
    // Needed on both sides so the year-gap veto (duplicates.ts) can tell a
    // same-title/different-year pair apart, not just when the incoming ref has one.
    year: parseYear(p.year),
  }
}

function refToDupRecord(entry: RefEntry): DupRecord {
  return { title: entry.title, authors: entry.authors, doi: entry.doi, year: entry.year }
}

/**
 * The existing paper a parsed reference *certainly* refers to, if any (DOI or
 * exact normalized title). A merely *probable* match is deliberately not
 * returned here: callers fill fields into the result or skip the row
 * outright, neither of which is safe on a guess. Delegates to
 * `classifyImport` so there is one place deciding "the same paper".
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
  // Unlike every other field here, a heuristic-extracted abstract IS allowed
  // to be overwritten: it's lower-confidence than one a reference manager recorded.
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
 * A batch with at least one `classifyImport`-flagged *probable* duplicate,
 * waiting on the reviewer's per-pair decision before anything is written
 * (same "nothing committed until a choice is made" shape as
 * `ScreeningImportDraft`). Only a `'probable'` verdict is ever read from `decisions`.
 */
export interface DuplicateReviewDraft {
  sourceName: string
  entries: RefEntry[]
  /** Index-aligned with `entries`, straight from `classifyImport`. */
  verdicts: DupVerdict[]
  /** `existingUids[j]` is the uid `classifyImport`'s `{ where: 'existing', index: j }`
   *  refers to — a snapshot, since a verdict's index only makes sense against
   *  the papers array as it stood at classification time. */
  existingUids: string[]
  /** Keyed by entry index; absent means "not decided yet". */
  decisions: Record<number, DuplicateDecision>
}

/**
 * Commit a parsed batch into `s.papers`, in index order, per verdict and (for
 * `'probable'`) the reviewer's decision.
 *
 * Must run in index order: a `{ where: 'batch', index }` target always points
 * at an earlier entry, so `resolvedUid[target.index]` is already set by the
 * time entry `i` runs — resolving chained matches without needing a union-find.
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

/** How long a version stays open to further edits when there is no git to
 *  tell whether anyone else can have it yet. */
const PRIVATE_VERSION_MS = 6 * 60_000

/**
 * Has the current schema version not left this machine yet? In a repository:
 * HEAD does not have it, i.e. it was never committed. Without one: it is
 * younger than `PRIVATE_VERSION_MS`. When unsure (git fails), no.
 */
async function versionIsPrivate(st: EditorState): Promise<boolean> {
  const current = st.schemaHistory.find((e) => e.id === st.schemaVersion)
  if (!current || !st.location?.path) return false
  const git = getPlatform().getGit?.()
  const repo = git ? await git.info(st.location.path).catch(() => null) : null
  if (git && repo) {
    const head = await git.headContent(repo.root, repo.relPath).catch(() => undefined)
    if (head === undefined) return false
    if (head === null) return true
    try {
      const headHistory = parseSchemaHistory((JSON.parse(head) as { schemaHistory?: unknown }).schemaHistory)
      return !headHistory.some((e) => e.id === current.id || e.absorbed?.some((a) => a.id === current.id))
    } catch {
      return false
    }
  }
  return Date.now() - Date.parse(current.at) < PRIVATE_VERSION_MS
}

/**
 * The version a changed schema is saved under: the current one amended while
 * it is still private (so the history is not one entry per save), otherwise a
 * new one after it. Either way it records the renames and moves whose answers
 * should follow.
 */
async function nextSchemaVersion(
  st: EditorState,
): Promise<{ schemaVersion: string; schemaHistory: SchemaHistoryEntry[] }> {
  const moves = pendingSchemaMoves(st.savedNodes, st.nodes, st.keepHidden)
    .filter((m) => m.carried && !m.kept)
    .map(({ from, to }) => ({ from, to }))
  const at = new Date().toISOString()
  if (st.schemaVersion && (await versionIsPrivate(st))) {
    const amended = amendVersion(st.schemaHistory, st.schemaVersion, moves, at)
    if (amended) return { schemaVersion: amended.id, schemaHistory: amended.history }
  }
  const id = newSchemaVersionId()
  const entry: SchemaHistoryEntry = { id, parents: st.schemaVersion ? [st.schemaVersion] : [], at, moves }
  return { schemaVersion: id, schemaHistory: [...st.schemaHistory, entry] }
}

/** The schema as a save would write it, to tell whether it changed. */
function savedSchemaJsonOf(state: { screening?: ScreeningConfig | null; nodes: EditorNode[] }): string {
  return JSON.stringify(state.screening ? screeningSchemaDefs(state.screening) : toAnnotationDefs(state.nodes))
}

/** Assemble the raw JSON object the editor writes. */
export function buildProjectJson(state: {
  version: number
  title?: string
  aiEnabled: boolean
  /** Optional so callers predating this option keep compiling; absent means
   *  enabled, matching `Project.finishCheckbox`'s default. */
  finishCheckbox?: boolean
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
  /** Optional for the same reason; see `model/schemaVersion.ts`. */
  schemaVersion?: string | null
  schemaHistory?: SchemaHistoryEntry[]
  /** Optional for the same reason; empty/absent means the default folder. */
  annotationsDir?: string
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
    ...(state.annotationsDir?.trim() ? { annotationsDir: state.annotationsDir.trim() } : {}),
    ...(state.schemaVersion ? { schemaVersion: state.schemaVersion } : {}),
    ...(state.schemaHistory && state.schemaHistory.length > 0 ? { schemaHistory: state.schemaHistory } : {}),
    // `ai` is only written when disabled, and `reviewers` only when it says
    // more than the single-reviewer default — matching serializeProject.
    config: {
      // A screening draft's schema is the derived projection of its reasons,
      // never the (empty) authored node list — see `Project.screening`.
      schema: screening ? screeningSchemaDefs(screening) : toAnnotationDefs(state.nodes),
      ...(state.aiEnabled ? {} : { ai: false }),
      ...(state.finishCheckbox === false ? { finishCheckbox: false } : {}),
      ...(state.reviewers > 1 ? { reviewers: state.reviewers } : {}),
      ...(screening ? { screening: { reasons: screening.reasons } } : {}),
    },
    papers: state.papers.map((p) => {
      const out: Record<string, unknown> = { ...(p.extra ?? {}) }
      out.id = p.id.trim()
      out.title = p.title.trim()
      out.authors = splitAuthors(p.authors)
      // A second serializer (doesn't go through `serializeProject`), so the
      // string→number boundary for `year` lives here, mirroring `editorStateFromOpened`.
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
  finishCheckbox?: boolean
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
    const id = p.id.trim()
    if (!id) {
      errors.push(`Paper ${i + 1}: missing id.`)
    } else {
      // The id becomes a directory name verbatim (`splitProjectFiles` in
      // `src/model/project.ts`) — reject anything that would break, or
      // silently mismatch, on some teammate's checkout.
      const problem = paperIdProblem(id)
      if (problem) errors.push(`Paper ${i + 1}: id "${id}" cannot be a folder name — ${problem.detail}.`)
    }
    if (!p.title.trim()) errors.push(`Paper ${i + 1}: missing title.`)
    // Screening runs on title + abstract from a reference-manager export with
    // no PDFs at all, so a PDF is only required outside of screening.
    if (!p.pdf.trim() && !screening) errors.push(`Paper ${i + 1} has no PDF attached.`)
  })
  const ids = state.papers.map((p) => p.id.trim()).filter(Boolean)
  // Not just an exact string match: a case-only or Unicode-normalisation-only
  // difference collapses to the same directory on a case-insensitive
  // checkout, or across macOS's NFD-normalising filesystem — see `paperIdsCollide`.
  const collidingIds = new Set<string>()
  ids.forEach((id, i) => {
    if (ids.some((other, j) => j !== i && paperIdsCollide(id, other))) collidingIds.add(id)
  })
  if (collidingIds.size > 0) errors.push(`Duplicate paper id(s): ${[...collidingIds].join(', ')}.`)

  // Only run the structural validators once the basics hold, so their messages
  // don't pile on top of the friendlier ones above.
  if (errors.length > 0) return errors

  const json = buildProjectJson(state)
  try {
    const raw = projectSchema.parse(json)
    // `buildProjectJson` always writes a non-empty `config.schema`; the zod
    // type is only optional to accommodate other schema-validation failures.
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

/** One paper carried over from a screening project. Narrower than `EditorPaper`:
 *  `reviews`/`equal`/`aiUsage` are the screening phase's own record, meaningless
 *  against a different (annotation) schema. */
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
 * What `startFromScreening`/`importFromScreening` found, before the reviewer
 * answers "what about the papers nobody screened yet" — `resolveScreeningImport`
 * is what actually commits rows.
 */
export interface ScreeningImportDraft {
  /** `start`: a fresh editor session next to the screening JSON. `import`:
   *  add rows into the editor session already open. */
  target: 'start' | 'import'
  /** Which kind of project `target: 'start'` creates. Meaningless for
   *  `target: 'import'` — that session's kind is already fixed. */
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
  /** Undecided papers every reviewer decided identically, not yet adopted by
   *  Consolidation (see `pendingUnanimousDecisions`) — surfaced but not
   *  auto-carried, since adopting them would change the inclusion counts.
   *  Only nonzero when `reviewers > 1`. */
  pendingUnanimousCount: number
  /** The source's seat count. Not a `multiReviewer` boolean: a `startKind:
   *  'screening'` target inherits it outright (see `resolveScreeningImport`). */
  reviewers: number
  /** Every id in the source project, carried or not: a `target: 'start'`
   *  project shares the source's directory (and `annotations/` folder), so a
   *  reused id would collide with a file the source still owns — see
   *  `resolveScreeningImport`. */
  sourceIds: string[]
}

/** `annotations` is the consolidated tree that ships, single- or
 *  multi-reviewer (see `openwiki/architecture.md`); `reviews` would be one
 *  reviewer's opinion, not the project's actual result. */
function partitionScreeningPapers(project: Project): {
  included: ScreeningImportRow[]
  undecided: ScreeningImportRow[]
  excludedCount: number
  excludedByReason: Record<string, number>
} {
  const included: ScreeningImportRow[] = []
  const undecided: ScreeningImportRow[] = []
  let excludedCount = 0
  // Null-prototype: a plain object let a reason of "constructor" tally onto a
  // function and "__proto__" hit the prototype setter, dropping the row.
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
  /** Whether reviewers sign papers off by hand — see `Project.finishCheckbox`.
   *  Carried untouched so editing a schema never silently changes it. */
  finishCheckbox: boolean
  /** Independent reviewers before Consolidation reconciles them; 1 = single-reviewer. */
  reviewers: number
  /** Set when this draft is a screening project: its schema is derived from
   *  these reasons (`src/screening/schema.ts`) and `nodes` is unused —
   *  `ProjectEditor` renders `ScreeningReasonsEditor` instead of
   *  `SchemaTreeEditor` whenever this is non-null. */
  screening: ScreeningConfig | null
  extra: Record<string, unknown>
  /** Set when this project's papers were imported from another (see
   *  `resolveScreeningImport`); null otherwise. Never edited in the UI —
   *  a durable record, not a setting. */
  provenance: ProjectProvenance | null
  /** The review's authored protocol, or null. Unlike `provenance`, this one
   *  *is* edited in the UI (`ProjectEditor`'s protocol section). */
  protocol: ProjectProtocol | null
  /** Free-text "about this schema" note, or null. Edited in the UI alongside
   *  the schema tree; shown to reviewers via `AnnotationPanel`'s info button. */
  schemaInfo: string | null
  /** The schema's version id and history (see `model/schemaVersion.ts`).
   *  Not part of undo: they describe what was saved, not the draft. */
  schemaVersion: string | null
  schemaHistory: SchemaHistoryEntry[]
  /** The schema as last saved, to tell which nodes were renamed or moved. */
  savedNodes: EditorNode[]
  /** `config.schema` as last saved; a save that changes it gets a new version. */
  savedSchemaJson: string
  /** Nodes whose answers the reviewer chose to leave hidden rather than move. */
  keepHidden: Record<string, true>
  /** The annotations folder's name as typed; empty means the default. */
  annotationsDir: string
  /** The folder's name as last saved, to tell a rename that must move it. */
  savedAnnotationsDir: string
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
  /** Papers added this session the reviewer hasn't looked at yet, keyed by
   *  `uid`. Mirrors the annotation store's `aiMarks`: session-only, not part
   *  of undo (the add already has its own step; unmarking isn't a meaningful
   *  edit to revert to), never written to the file. */
  justAdded: Record<string, true>
  /** Undo/redo history of draft edits (session-only). */
  past: EditorSnapshot[]
  future: EditorSnapshot[]
  /** A screening project picked via `startFromScreening`/`importFromScreening`,
   *  parsed and partitioned, waiting on the reviewer's answer to "what about
   *  the papers nobody screened yet". Session-only — nothing committed yet,
   *  so nothing for undo to know about. */
  screeningImport: ScreeningImportDraft | null
  /** Set by `importReferences` when `classifyImport` found a *probable*
   *  duplicate in the batch — nothing committed yet. Session-only, same
   *  reasoning as `screeningImport`. */
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
  /** Toggle hand sign-off for this project — see `Project.finishCheckbox`.
   *  Its own undo step, like `setScreening`. */
  setFinishCheckbox: (on: boolean) => void
  /** Turn screening on (seeding `DEFAULT_SCREENING_REASONS`) or off. Its own undo step. */
  setScreening: (on: boolean) => void
  setScreeningReasons: (reasons: string[]) => void
  /** Rewrite an exclusion reason across every paper that recorded it (see
   *  `renameReasonInPapers`), so a rename doesn't orphan existing decisions.
   *  Its own undo step. */
  migrateScreeningReason: (from: string, to: string) => void
  /** Replace the whole authored protocol; pass `null` to clear it. Coalesced
   *  like `setTitle` so a burst of typing is one undo step. */
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

  /** Create a new project (annotation or screening, reviewer's choice) from a
   *  screening project's included papers: pick the JSON, then open the
   *  pre-commit summary (`screeningImport`) before anything is written. */
  startFromScreening: () => Promise<void>
  /** The papers-only half of the above, for an editor session already open. */
  importFromScreening: () => Promise<void>
  /** Choose what `target: 'start'` builds. No-op with no pending import, or
   *  one targeting an already-open session. Not undoable — session-only. */
  setScreeningImportKind: (kind: 'annotation' | 'screening') => void
  /** Answer the pre-commit import summary opened by either action above. */
  resolveScreeningImport: (choice: 'include-undecided' | 'skip-undecided' | 'cancel') => Promise<void>

  /** Decide one probable-duplicate row in the open `duplicateReview`. A no-op
   *  if there is no open review, or the row isn't `'probable'`. */
  setDuplicateDecision: (entryIndex: number, decision: DuplicateDecision) => void
  /** Decide every still-open `'probable'` row at once. */
  setAllDuplicateDecisions: (decision: DuplicateDecision) => void
  /** `'apply'` commits the batch (every `'probable'` row must already be
   *  decided — see `DuplicateReviewDialog`); `'cancel'` discards it all.
   *  Synchronous: `importReferences` already did the file reading. */
  resolveDuplicateReview: (choice: 'apply' | 'cancel') => void

  undo: () => void
  redo: () => void

  /** Write the JSON and stay in the editor. */
  save: () => Promise<boolean>
  /** Leave the answers of a renamed or moved node hidden, or move them after all. */
  setKeepHidden: (uid: string, keep: boolean) => void
  setAnnotationsDir: (name: string) => void
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
    finishCheckbox: s.finishCheckbox,
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
  s.finishCheckbox = snap.finishCheckbox
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
  finishCheckbox: boolean
  reviewers: number
  screening: ScreeningConfig | null
  extra: Record<string, unknown>
  provenance: ProjectProvenance | null
  protocol: ProjectProtocol | null
  schemaInfo: string | null
  schemaVersion: string | null
  schemaHistory: SchemaHistoryEntry[]
  annotationsDir: string
  nodes: EditorNode[]
  papers: EditorPaper[]
}

/**
 * Parse an opened project into the editor's draft shape. Throws on invalid
 * JSON or a rejected structure so callers can show a friendly error. Shared
 * by "Edit annotation JSON…" and the per-recent pen.
 */
export function editorStateFromOpened(opened: OpenedProject): OpenedEditorState {
  const data = JSON.parse(opened.text) as Record<string, unknown>
  const parsed = projectSchema.parse(data)
  // Trimmed/deduped like `project.ts`'s loader — a broken reasons list should
  // open into the reasons editor so it can be fixed, not fail to load.
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
    // Same lenient `year` repair as `project.ts`'s loader, so a hand-edited
    // `"2021"` string opens here rather than landing in `extra`.
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
  // Shared `KNOWN_ROOT_KEYS`, not a second hand-maintained list, so a key
  // parsed explicitly below (like `provenance`) can't also ride along in
  // `extra` and look "changed" on every diff.
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
    // Same rule, same reason — see `Project.finishCheckbox`.
    finishCheckbox: (parsed.config as { finishCheckbox?: unknown }).finishCheckbox !== false,
    // Absent or 1 means single-reviewer, same default as project.ts's loader.
    reviewers: parsed.config.reviewers ?? 1,
    screening,
    extra: rootExtra,
    provenance: parseProvenance(data.provenance),
    protocol: parseProtocol(data.protocol),
    schemaInfo: parseSchemaInfo(data.schemaInfo),
    schemaVersion: parseSchemaVersion(data.schemaVersion),
    schemaHistory: parseSchemaHistory(data.schemaHistory),
    annotationsDir: typeof data.annotationsDir === 'string' ? data.annotationsDir : '',
    // A screening project's schema is derived, not authored, so there is
    // nothing for the schema-builder tree to hold — see `ProjectEditor.tsx`.
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
  s.finishCheckbox = st.finishCheckbox
  s.reviewers = st.reviewers
  s.screening = st.screening
  s.extra = st.extra
  s.provenance = st.provenance
  s.protocol = st.protocol
  s.schemaInfo = st.schemaInfo
  s.schemaVersion = st.schemaVersion
  s.schemaHistory = st.schemaHistory
  s.savedNodes = st.nodes
  s.savedSchemaJson = savedSchemaJsonOf(st)
  s.keepHidden = {}
  s.annotationsDir = st.annotationsDir
  s.savedAnnotationsDir = st.annotationsDir
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

/**
 * Take focus off the field being typed into, firing its `blur` handler — the
 * schema field name / screening reason editors hang their confirm-before-
 * losing-answers guard there (`SchemaTreeEditor.tsx`'s `commitRename`), and
 * neither a keyboard shortcut nor a macOS/Chromium button click moves focus
 * on its own. Called at the top of `save`/`saveAs` (rather than by each
 * caller) so the native quit dialog's Save button gets the same guard.
 * Synchronous, so the rest of `save`/`saveAs` sees the result.
 */
function commitFocusedEdit(): void {
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.blur()
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
     * Shared by `addPdfs`/`addPdfFolder` (differ only in how PDFs are picked).
     * Skips already-referenced PDFs, adds a row per new one with a
     * name-derived placeholder marked "just added", then reads title/authors
     * in the background without clobbering anything typed meanwhile.
     */
    const addPickedPdfs = async (picked: PickedPdf[]) => {
      if (picked.length === 0) return
      const platform = getPlatform()
      const rel = await platform.relativePdfPaths(picked, get().location)

      // Skip PDFs already referenced: match on absolute path when we have one,
      // else the stored relative path, so re-picking a file doesn't duplicate it.
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
    // Off by default: AI-assisted annotation has no reachable entry point
    // (see `aiUnlocked` in store.ts) and no UI here to re-enable it, so a new
    // project shouldn't silently claim a feature nobody can use.
    aiEnabled: false,
    // Enabled by default, unlike `aiEnabled`: hand sign-off is every
    // project's behavior unless its author opts out.
    finishCheckbox: true,
    reviewers: 1,
    screening: null,
    extra: {},
    provenance: null,
    protocol: null,
    schemaInfo: null,
    schemaVersion: null,
    schemaHistory: [],
    savedNodes: [],
    savedSchemaJson: '',
    keepHidden: {},
    annotationsDir: '',
    savedAnnotationsDir: '',
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
        s.finishCheckbox = true
        s.reviewers = 1
        s.screening = null
        s.extra = {}
        s.provenance = null
        s.protocol = null
        s.schemaInfo = null
        s.schemaVersion = null
        s.schemaHistory = []
        s.savedNodes = []
        s.savedSchemaJson = ''
        s.keepHidden = {}
        s.annotationsDir = ''
        s.savedAnnotationsDir = ''
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
        // File gone: grey the entry (the drive may come back) and surface the
        // error on the welcome screen, as store.openRecent does for annotate.
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
        // Clear dirty: otherwise Electron's quit guard (`useElectronCloseGuard`,
        // which prompts when either store is dirty) keeps claiming unsaved
        // changes for a draft the user already chose to discard.
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
      // PDFs are relative to the JSON, so moving it re-derives every path.
      // Two mechanisms: papers added this session still have an absolute
      // `sourcePath` to re-derive from exactly; papers loaded from the file
      // have none (`editorStateFromOpened` leaves it undefined), so their
      // `pdf` — relative to the *current* location — is re-anchored via
      // `rebasePdfPaths` instead (same call `store.ts`'s `saveAs` makes).
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

    setFinishCheckbox: (on) => {
      // A single toggle, so it is its own undo step (no coalescing) — same
      // shape as `setScreening` below.
      lastEditKey = null
      const snap = snapshotOf(get())
      set((s) => {
        pushPast(s, snap)
        s.finishCheckbox = on
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
        // `required` is meaningless on a group (no value) or boolean (never
        // empty, see `resolveSchema`) — cleared so switching type drops the stale flag.
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

      // Classified before the mutating `set` below — `classifyImport` is pure
      // and synchronous, so nothing changes between this read and that call.
      const papers = get().papers
      const existingUids = papers.map((p) => p.uid)
      const verdicts = classifyImport(papers.map(paperToDupRecord), entries.map(refToDupRecord))

      // A probable match always goes through the reviewer, never silently
      // merged or duplicated; `certain`/`new` don't, or a routine re-import
      // of an unchanged `.bib` would be a wall of prompts.
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
      // Common case: every field focus in an untouched list calls this, so
      // don't churn the store for a mark that isn't there.
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
          // Deciding this silently would undermine the dialog's whole point —
          // the reviewer opts into a second screening pass via its radio.
          startKind: 'annotation',
          sourceHandle: opened.handle,
          sourceName: opened.name,
          sourceTitle: project.title,
          screening: project.screening!,
          ...partition,
          pendingUnanimousCount: pendingUnanimousDecisions(project),
          reviewers: project.reviewers,
          sourceIds: project.papers.map((p) => p.id),
        }
      })
    },

    importFromScreening: async () => {
      // Importing into an open screening project is well-defined (a carried
      // row just arrives undecided under its reasons) but stays blocked: the
      // two-pass workflow is already served by `startFromScreening`'s second,
      // independent project, and unblocking this is a separate feature with
      // no demonstrated need.
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
          sourceIds: project.papers.map((p) => p.id),
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
      // Carried by default: silently dropping an undecided paper from a
      // systematic review is unacceptable, so only an explicit `Decision:
      // 'Exclude'` (or the reviewer's own opt-out) ever drops one.
      const carried =
        choice === 'include-undecided' ? [...draft.included, ...draft.undecided] : draft.included

      set((s) => {
        s.busy = true
      })
      const platform = getPlatform()

      // Default save location is next to the screening JSON: a sibling shares
      // its directory, so every carried paper's relative `pdf` still resolves
      // without being rewritten.
      let location: ProjectLocation | null = null
      if (draft.target === 'start') {
        const baseName = (draft.sourceHandle.path ?? draft.sourceName).split(/[\\/]/).pop() ?? draft.sourceName
        // "-fulltext", not "-screening": names the workflow (the second pass
        // *is* the full-text screen), not the data shape. Only a suggestion —
        // the save dialog lets the reviewer rename.
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
      // path the screening file stored — otherwise `changeLocation` (which
      // only re-derives `pdf` for rows with a `sourcePath`) would silently
      // leave every PDF pointing at nothing after a later "Change…".
      const absolutes = await platform.absolutePdfPaths(carried.map((p) => p.pdf), draft.sourceHandle)

      // Merging into an already-open session drops papers into whatever
      // directory it already lives in — not the screening project's own, so
      // re-derive `pdf` against it first (same `relativePdfPaths` pattern as
      // `changeLocation`'s "Save as"), or every path points at nothing.
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
        // `target: 'start'` shares the source's directory and `annotations/`
        // folder, so a carried id equal to any source paper's id would make
        // this pass's undecided marks overwrite the source's recorded decision.
        const taken = new Set(draft.sourceIds)
        const rows: EditorPaper[] = carried.map((p, i) => {
          const hasSource = !!absolutes[i]
          // `target: 'start'` never rebases (correct by construction);
          // `target: 'import'` uses the re-derived path when computed, else
          // falls back to the verbatim value.
          const pdf = draft.target !== 'start' && hasSource ? (rebased[rebasedIdx++] ?? p.pdf) : p.pdf
          let id = p.id
          if (draft.target === 'start') {
            let n = 2
            while (taken.has(id)) id = `${p.id}-${n++}`
            taken.add(id)
          }
          return {
            uid: nextUid(),
            id,
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
          // Same reasoning as the initial-state comment above: no reachable
          // AI feature, so a fresh project starts opted out even here.
          s.aiEnabled = false
          s.finishCheckbox = true
          // A second screening pass keeps the same team, so its seat count
          // (a PRISMA-reportable design property) is inherited, not reset to
          // 1 — that would silently turn dual-screening into single. The
          // annotation target has its own independent staffing default.
          s.reviewers = screeningTarget ? draft.reviewers : 1
          // Seeded from the source's own reasons, not DEFAULT_SCREENING_REASONS:
          // they're the pre-registered protocol's vocabulary, and PRISMA
          // reports exclusions per reason across both passes — a disjoint
          // generic list would make the two un-poolable. Still editable in
          // ScreeningReasonsEditor.
          s.screening = screeningTarget ? { reasons: [...draft.screening.reasons] } : null
          s.extra = {}
          // Derived from `screening.reasons`, not authored (see
          // `Project.screening`) — same empty-array reasoning as
          // `editorStateFromOpened`.
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
          // Not carried from the source: the import draft doesn't currently
          // capture the source's protocol; threading it through is a
          // separate change. Starts empty, like a from-scratch project.
          s.protocol = null
          s.schemaInfo = null
          s.schemaVersion = null
          s.schemaHistory = []
          s.savedNodes = []
          s.savedSchemaJson = ''
          s.keepHidden = {}
          // A folder of its own next to the source's, so the two never need
          // telling apart even if a paper id they share is added later.
          s.annotationsDir = defaultSplitDirName(location.name)
          s.savedAnnotationsDir = ''
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
          // Adding into an already-open session: one undo step for the whole
          // import, and a paper already present (by DOI, then normalized
          // title — same rule `importReferences` uses) is skipped, not duplicated.
          const existingIds = new Set(s.papers.map((p) => p.id))
          // Same-directory import: marks-*.json filenames are identical
          // between screening/annotation, so an id matching one in the
          // source's `annotations/` folder would overwrite its PDF marks,
          // even for a non-duplicate paper.
          for (const id of draft.sourceIds) existingIds.add(id)
          const toAdd: EditorPaper[] = []
          let skipped = 0
          for (const row of rows) {
            // Pass the row's whole identity, not just title/DOI: omitting
            // authors/year disables the disjoint-author demotion and the
            // year-gap veto, so a merely same-titled paper was misreported as
            // "already in the project" and silently dropped. `importReferences`
            // already gets this right by passing full records.
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
      // Must run before anything below reads the draft — see
      // `commitFocusedEdit`'s own comment.
      commitFocusedEdit()
      const st = get()
      if (!st.location) {
        set((s) => {
          s.error = { message: 'Choose where the JSON should be stored first.', details: [] }
        })
        return false
      }
      const issues = validateDraft(st)
      const folder = st.annotationsDir.trim() || DEFAULT_ANNOTATIONS_DIR
      const folderProblem = st.annotationsDir.trim() ? annotationsDirProblem(folder) : null
      if (folderProblem) issues.push(`Annotations folder "${folder}": ${folderProblem}.`)
      else if (st.location.path) {
        const ids = st.papers.map((p) => p.id.trim())
        const users = (await getPlatform().annotationsDirUsers?.(st.location.path, folder, ids).catch(() => [])) ?? []
        if (users.length > 0) {
          issues.push(
            `Annotations folder "${folder}" is also used by ${users.join(', ')} next to this file, which lists some of ` +
              'the same papers — the two would write the same files there. Choose another folder name.',
          )
        }
      }
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
        // A changed schema is a new version, recording the renames and moves
        // whose answers should follow. Only kept in state once written, so a
        // failed save does not leave a version behind that no file has.
        const schemaJson = savedSchemaJsonOf(st)
        const versioned = schemaJson === st.savedSchemaJson ? st : { ...st, ...(await nextSchemaVersion(st)) }
        // An existing project's folder moves before the project file says so;
        // the move records the new name itself, and is refused rather than
        // half-done.
        const savedFolder = st.savedAnnotationsDir.trim() || DEFAULT_ANNOTATIONS_DIR
        // (`savedSchemaJson` is set once the file exists: opened, or saved before.)
        if (st.savedSchemaJson !== '' && st.location.path && folder !== savedFolder) {
          await getPlatform().moveAnnotationsDir(st.location.path, folder)
        }
        const text = JSON.stringify(buildProjectJson(versioned), null, 2)
        const handle = await getPlatform().saveProject(text, st.location.handle)
        set((s) => {
          s.schemaVersion = versioned.schemaVersion
          s.schemaHistory = versioned.schemaHistory
          s.savedNodes = st.nodes
          s.savedSchemaJson = schemaJson
          s.keepHidden = {}
          s.savedAnnotationsDir = st.annotationsDir
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

    setAnnotationsDir: (name) => {
      set((s) => {
        s.annotationsDir = name
        s.dirty = true
      })
    },

    setKeepHidden: (uid, keep) => {
      set((s) => {
        if (keep) s.keepHidden[uid] = true
        else delete s.keepHidden[uid]
      })
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
