import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  loadProject,
  serializeProject,
  needsShapeMigration,
  deepEqualJson,
  ProjectLoadError,
  type Project,
  type Paper,
} from '../model/project'
import { alignedReviews, type StoredAlignment, type StoredSlot } from '../model/alignment'
import {
  hasAnnotations,
  makeInstance,
  normalizeTree,
  type AnnotationValueTree,
  type FieldValue,
  type InstanceNode,
} from '../model/annotations'
import type { ResolvedDef } from '../model/schema'
import { MARK_COLORS, type MarkRect, type PdfMark, dedupeMarkGroups } from '../model/pdfMarks'
import { alignNode, alignableNodes, widenAlignment, type TreeAlignment } from '../consolidate/align'
import { growConsolidated, toStoredAlignment, storedAsTreeAlignment } from '../consolidate/apply'
import { unanimousFills } from '../consolidate/unanimous'
import { consolidatorHasAnswered } from '../consolidate/readiness'
import { validateProject, type UnannotatedPaper, type ValidationIssue } from '../model/validate'
import { formatPath, displayPath, resolvePath, parsePath, MAX_UNBOUNDED_INDEX } from '../llm/paths'
import { isUnanswered } from '../llm/fields'
import type { Suggestion } from '../llm/types'
import {
  DECISION_EXCLUDE,
  SCREENING_DECISION,
  SCREENING_REASON,
} from '../screening/schema'
import { screeningStatus, type ScreeningStatus } from '../screening/status'
import {
  annotationStateFor,
  completenessApplies,
  type AnnotationFilter,
} from '../model/annotationState'
import { screeningIssues } from '../screening/validate'
import { extractPdfMeta } from '../model/pdfMeta'
import {
  fetchLatestRelease,
  updateFrom,
  CHECK_INTERVAL_MS,
  type UpdateInfo,
} from '../model/version'
import { getPlatform, type SaveHandle } from '../platform'
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
  loadAutosaveEnabled,
  saveAutosaveEnabled,
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

/** Key of a Consolidation field deferred for a different, manually entered value. */
export function deferredConsolidationKey(paperId: string, canonicalPath: string): string {
  return `${paperId}::${canonicalPath}`
}

/** Canonical path of a field instance as the UI addresses it (container path + leaf). */
export function fieldPath(path: PathSeg[], name: string, index: number): string {
  return formatPath([...path, { name, index }])
}

/**
 * Rewrite a canonical path after the instance at `path/name[index]` was
 * removed from a repeatable list. Every sibling after the removed index
 * shifts down by one, so any path/key naming it (mark links, AI marks,
 * `paper.equal`, deferred consolidations) has to shift with it or it keeps
 * pointing at whichever entry inherited the old slot. Returns `null` when
 * `canonical` named the removed instance itself (or something inside it) —
 * the caller drops those. Defensive-parse convention: an unparseable or
 * unrelated path comes back unchanged rather than throwing.
 */
export function shiftCanonicalPath(
  canonical: string,
  path: PathSeg[],
  name: string,
  index: number,
): string | null {
  const segs = parsePath(canonical)
  if (!segs) return canonical
  const depth = path.length
  if (segs.length <= depth) return canonical
  for (let i = 0; i < depth; i++) {
    const seg = segs[i]
    if (seg.name.trim() !== path[i].name.trim() || seg.index !== path[i].index) return canonical
  }
  const seg = segs[depth]
  if (seg.name.trim() !== name.trim()) return canonical
  if (seg.index === index) return null
  if (seg.index > index) {
    const next = [...segs]
    next[depth] = { name: seg.name, index: seg.index - 1 }
    return formatPath(next)
  }
  return canonical
}

/**
 * Descend into `alignment` along `path` to find the slots for node `name`,
 * the same way `containerAt` descends the annotation tree — except a step
 * here does not mean "index `seg.index` of this array", it means "whichever
 * slot the caller's notion of `seg.index` belongs to", because `alignment`'s
 * levels are keyed by node name and addressed by slot position, not by any
 * one reviewer's array index directly.
 *
 * `resolveIndex` is what tells the two callers of `removeInstance`'s
 * alignment fixup apart: a reviewer's own edit names *their* array index at
 * each level, so it has to search `members` for it; a consolidator's edit
 * names the consolidated array's own index, which (by `growConsolidated`'s
 * invariant that the consolidated array is never reordered, only grown) is
 * the slot's position directly.
 *
 * Returns `undefined` wherever the path does not resolve — an unaligned node,
 * or a segment `resolveIndex` cannot place — so the caller can simply skip
 * the fixup rather than fabricate a slot list that was never computed.
 */
function alignmentSlotsAt(
  alignment: StoredAlignment,
  path: PathSeg[],
  name: string,
  resolveIndex: (slots: StoredSlot[], seg: PathSeg) => number,
): StoredSlot[] | undefined {
  let level = alignment
  for (const seg of path) {
    const slots = level[seg.name]
    if (!slots) return undefined
    const slotIndex = resolveIndex(slots, seg)
    if (slotIndex < 0 || slotIndex >= slots.length) return undefined
    level = slots[slotIndex].children ?? {}
  }
  return level[name]
}

/** The reviewer scope a mark key should use right now: `null` for a
 *  single-reviewer project (so its keys stay byte-for-byte the old format),
 *  otherwise the current selection. */
function markReviewerScope(project: Project | null, currentReviewer: string | null): string | null {
  return project && project.reviewers > 1 ? currentReviewer : null
}

function isDeferredValueEmpty(value: FieldValue): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
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
 *
 * This is deliberately per-machine, `localStorage`, keyed by clone path: it
 * is a local convenience so reopening the file does not ask again and is
 * never written into the shared project JSON.
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

const READING_POSITION_KEY_PREFIX = 'slr.readingPosition.'

/** Same per-machine, `localStorage`, keyed-by-path convention as
 *  `reviewerStorageKey` — see its own doc comment. Reopening the file should
 *  land back on the paper and PDF page a reviewer was last looking at,
 *  purely as a local convenience; it has no business in the shared project
 *  JSON, where it would just be diff noise every time someone opens the file. */
function readingPositionKey(handle: SaveHandle | null): string | null {
  return handle?.path ? `${READING_POSITION_KEY_PREFIX}${handle.path}` : null
}

interface StoredReadingPosition {
  paperId: string
  page: number
  /** How far scrolled into `page`, as a fraction of that page's own rendered
   *  height (0 = its very top, close to 1 = near its bottom) — the same
   *  "fraction of the page" convention `MarkRect` already uses, chosen for
   *  the same reason: resolution/zoom-independent, so it still lands in
   *  roughly the right spot even if the page renders at a different size
   *  than it did when this was captured. Optional so an older stored value
   *  (page only) still loads — treated as 0 (page top) when absent. */
  offsetFraction: number
}

/** The persisted reading position for this project, or null when there is
 *  none, the project has no stable key, or the stored value is malformed. Not
 *  checked against the project's own paper list here — `loadFromText` does
 *  that, since only it knows the freshly loaded papers. */
function loadReadingPosition(handle: SaveHandle | null): StoredReadingPosition | null {
  const key = readingPositionKey(handle)
  if (!key) return null
  const stored = safeGet(key)
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored) as { paperId?: unknown; page?: unknown; offsetFraction?: unknown }
    if (typeof parsed.paperId === 'string' && Number.isInteger(parsed.page) && (parsed.page as number) >= 1) {
      const offsetFraction =
        typeof parsed.offsetFraction === 'number' && Number.isFinite(parsed.offsetFraction)
          ? Math.min(1, Math.max(0, parsed.offsetFraction))
          : 0
      return { paperId: parsed.paperId, page: parsed.page as number, offsetFraction }
    }
  } catch {
    /* malformed — treat exactly like "none stored" */
  }
  return null
}

function saveReadingPosition(
  handle: SaveHandle | null,
  paperId: string | null,
  page: number,
  offsetFraction: number,
): void {
  const key = readingPositionKey(handle)
  if (!key || !paperId) return
  safeSet(key, JSON.stringify({ paperId, page, offsetFraction }))
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

/**
 * Bumped whenever the open project is *replaced or closed* — never for an
 * ordinary edit. A background read that outlives its project (see
 * `extractScreeningAbstract`) compares this to decide whether its result still
 * belongs anywhere.
 *
 * Reference equality on `project` cannot answer that question, even though
 * `loadFromText`'s auto-save uses it for its own narrower one: immer hands back
 * a **new** `project` object on every edit, so `get().project !== captured`
 * is true the moment the reviewer decides a single paper — which during
 * screening is constantly, and exactly while a PDF is being read. Guarding on
 * that would throw away a perfectly good abstract because someone pressed `I`.
 */
let projectGeneration = 0

interface AppState {
  project: Project | null
  currentPaperId: string | null
  saveHandle: SaveHandle | null
  projectName: string
  /** The project's own title from its JSON; empty when it doesn't set one. */
  projectTitle: string
  dirty: boolean
  /** `Date.now()` of the last successful save — drives the toolbar's transient
   *  "Saved" confirmation. `null` before any save this session. */
  lastSavedAt: number | null
  /** Persisted (`localStorage`) opt-in: periodically save unsaved changes
   *  without waiting for Ctrl+S. See `useAutosave`. */
  autosaveEnabled: boolean
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
  /** Whether the agreement-statistics dialog is open. Session-only, like `validationOpen`. */
  agreementOpen: boolean
  /** Whether the "export PDF with annotations" dialog is open. Session-only, like `validationOpen`. */
  exportPdfOpen: boolean
  /** Whether the schema-info dialog is open. Auto-set true by `loadFromText`
   *  when the opened project has a `schemaInfo` comment; otherwise toggled by
   *  the annotation panel's ⓘ button. Session-only, like `validationOpen`. */
  schemaInfoOpen: boolean
  /** A mark id `PdfViewer` should scroll to and flash, requested from
   *  elsewhere (the field-link popover's "jump to this mark" — clicking a
   *  candidate to see it in context before linking it). `PdfViewer` clears
   *  this itself once it has acted on it. Session-only. */
  pendingMarkJump: string | null
  /**
   * The paper/page a just-opened project's landing paper should scroll to on
   * its very first render, restored from `loadReadingPosition` — a reviewer
   * reopening a project lands back where they left off instead of wherever
   * `firstUnfinishedPaperId` would otherwise put them. `PdfViewer` consumes
   * this itself once its pages are actually mounted and clears it, the same
   * single-shot shape as `pendingMarkJump`. `paperId` guards against a
   * reviewer navigating to a different paper before the landing paper's PDF
   * finishes loading — `PdfViewer` also drops it outright the moment the
   * open paper no longer matches, so it can never misapply to a paper opened
   * later by hand. Session-only.
   */
  initialPdfPosition: { paperId: string; page: number; offsetFraction: number } | null
  /** Canonical field path whose link popover is open, or null. Session-only, like `validationOpen`. */
  openLinkPopoverField: string | null
  /** The mark `PdfViewer` most recently created (a highlight or note, not an
   *  edit to an existing one) and nobody has linked to a field yet — offered
   *  to the next field-link popover to open, auto-linking it there instead of
   *  making the reviewer find and click it in the list, since finishing a
   *  highlight and immediately going to link it is the whole point of having
   *  just made it.
   *
   *  Only stays valid through two kinds of "next thing" — see
   *  `lastCreatedMarkAllowedField` — anything else in between (editing a
   *  different field, adding/removing an instance, undo, touching another
   *  mark, ...) drops it back to `null` via `clearPendingMarkLink`, so a
   *  popover opened later offers nothing and the reviewer picks by hand.
   *  Cleared outright the moment a popover does consume it, so it is only
   *  ever offered once. Session-only, like `pendingMarkJump`. */
  lastCreatedMarkId: string | null
  /**
   * Narrows what `lastCreatedMarkId` may still be auto-linked to.
   *
   * `null` while nothing has happened yet since the mark was made — any
   * field's popover may still claim it (case (a): highlight, then link).
   * Set to a canonical field path the first time that field is edited —
   * from then on, only *that* field's popover may claim it (case (b):
   * highlight, type the value into the field it belongs to, then link) —
   * editing a *different* field invalidates the pending mark entirely
   * rather than re-narrowing, since a second field's answer is no longer
   * "the very next thing" after making the mark.
   */
  lastCreatedMarkAllowedField: string | null
  /**
   * Every mark id `addHighlight` has produced since the app was opened —
   * across every paper and reviewer seat, never pruned or reset by anything
   * short of quitting.
   *
   * Powers `orderMarksForLinking`'s "pin what you just made" section in the
   * field-link popover: it needs to tell "this highlight is from a minute
   * ago" from "this highlight has sat in the file since last week" apart,
   * and a mark's own `createdAt` alone cannot — a project opened for the
   * first time today has old marks with old timestamps, but nothing about
   * them is *recent* to this sitting. Not session-only in the sense the rest
   * of this section's fields are (those are cleared on project close); this
   * one is deliberately not, since "how long has this app been open"
   * doesn't reset just because the reviewer switched papers.
   */
  sessionCreatedMarkIds: string[]
  /** A canonical field path `AnnotationPanel` should scroll to and flash,
   *  requested from elsewhere (Validation's "jump to this field", clicking
   *  an issue rather than only the paper it's on). `AnnotationPanel` clears
   *  this itself once it has acted on it — same one-shot-request shape as
   *  `pendingMarkJump`. */
  pendingFieldJump: string | null
  /** The field currently pulsing after a jump — see `pendingFieldJump`.
   *  Set alongside clearing `pendingFieldJump`, cleared again after the
   *  flash animation's own duration. */
  flashFieldPath: string | null
  /** Restore the Consolidation overview when its Agreement dialog closes. */
  agreementReturnToOverview: boolean
  /** Whether the overall Consolidation overview is open. Session-only, like `validationOpen`. */
  consolidationOverviewOpen: boolean
  /** Whether the current paper's disagreement list is open. Session-only, like `validationOpen`. */
  disagreementsOpen: boolean
  /** Restore the Consolidation overview when it opened this paper's disagreement list. */
  disagreementsReturnToOverview: boolean
  /** Reopen the disagreement list after closing the field comparison it launched. */
  returnToDisagreements: boolean
  /**
   * Progress/result of the last `adoptAllUnanimousAnnotations` run, or null
   * before the first run and after `dismissUnanimousRun`. Session-only, like
   * `validationOpen`.
   */
  unanimousRun: UnanimousRun | null
  /**
   * Bumped whenever a different project is loaded or the current one closed.
   *
   * Components hold local UI state that is *about* the open project — a search
   * query, a filter — and `project` itself is not usable as a change signal
   * because immer swaps it on every keystroke. Without this, PaperList's search
   * survived a project switch and hid every paper in the newly opened one
   * behind a query typed against the last.
   */
  projectGeneration: number
  /** Shown when discarding an open project's unsaved changes. */
  closePromptOpen: boolean
  /**
   * What to do once the unsaved-changes prompt is answered. Closing is not the
   * only way to lose the open project — opening another one (or a recent)
   * replaces it just as completely — so the prompt has to carry the action it
   * is guarding rather than assume "close".
   */
  pendingAfterPrompt: { kind: 'close' } | { kind: 'open' } | { kind: 'openRecent'; id: string } | null
  /** The running version, injected from package.json at build time. */
  appVersion: string
  /** Set only when a *newer* release exists; null while up to date or unknowable. */
  update: UpdateInfo | null
  /** Download progress (0-100) of the native self-update, once started. Win/linux only. */
  updateProgress: number | null
  /** The native self-update has finished downloading and can be installed. */
  updateReady: boolean
  /** The native self-update's download/check failed. Cleared on the next attempt. */
  updateError: string | null
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
  /** Fields waiting for Consolidation to enter a value other than a reviewer's answer. */
  deferredConsolidations: Record<string, true>
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
  /** Which decisions the screening paper list shows. Session-only, like the search box's mode. */
  screeningFilter: ScreeningStatus | 'all'
  /** Which annotation state the (non-screening) paper list shows, and which
   *  one its "finished: 5/100" counter reports. Session-only, like
   *  `screeningFilter` — a filter is a way of looking at the project right
   *  now, not a property of it worth writing to the file. */
  annotationFilter: AnnotationFilter
  /** Screening reads title + abstract by default; the PDF is the escalation path. Session-only. */
  screeningShowPdf: boolean
  /** Whether the screening progress/PRISMA summary modal is open. Session-only. */
  screeningSummaryOpen: boolean
  /**
   * Per paper id, what `extractScreeningAbstract` has done about its PDF this
   * session: `'reading'` while the read is in flight (the record view shows a
   * notice), `'none'` once a read finished having found nothing — which is what
   * stops a PDF with no recognisable abstract from being re-fetched and
   * re-parsed on every single re-selection of that paper.
   *
   * A *successful* read deliberately leaves no entry: the abstract it wrote is
   * its own record, and `paper.abstract` is the guard that keeps it from
   * running again. That matters because an undo can restore a snapshot taken
   * before the abstract landed — leaving a marker here would then make the loss
   * permanent for the session, where instead re-selecting the paper simply
   * extracts again. Session-only, like `screeningShowPdf`.
   */
  screeningAbstractReads: Record<string, 'reading' | 'none'>

  openProject: () => Promise<void>
  openRecent: (id: string) => Promise<void>
  /**
   * Open another project, prompting to save first when the current one is
   * dirty. Every entry point a *user* can reach must go through these rather
   * than `openProject`/`openRecent` directly: replacing the open project
   * discards unsaved work exactly as closing it does, and used not to ask.
   */
  requestOpenProject: () => void
  requestOpenRecent: (id: string) => void
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
  loadFromText: (text: string, handle: SaveHandle | null, name: string) => void
  /** Re-reads the open project from disk in place, after a field-level git
   *  commit/discard rewrote the working file underneath it — see
   *  `gitStore.ts`'s `runCommit`/`runDiscard`. Unlike `loadFromText`, this is
   *  not "a project was opened": the reviewer's view (selected paper,
   *  filters, the schema-info dialog) is left exactly as it was, only the
   *  project data itself is refreshed. Undo/redo history is cleared, same as
   *  `loadFromText` — those snapshots branch off the project as it stood
   *  before this read, so keeping them would let a later Ctrl+Z silently
   *  resurrect exactly what the resync just discarded. */
  resyncProjectFromDisk: () => Promise<void>
  save: () => Promise<boolean>
  saveAs: () => Promise<boolean>
  setAutosaveEnabled: (enabled: boolean) => void
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
  /** Open/close the agreement-statistics dialog. View state only — see `agreementOpen`. */
  setAgreementOpen: (open: boolean) => void
  /** Open/close the "export PDF with annotations" dialog. View state only — see `exportPdfOpen`. */
  setExportPdfOpen: (open: boolean) => void
  /** Open/close the schema-info dialog. View state only — see `schemaInfoOpen`. */
  setSchemaInfoOpen: (open: boolean) => void
  /** Request/clear a "scroll to and flash this mark" — see `pendingMarkJump`. */
  setPendingMarkJump: (markId: string | null) => void
  /** `PdfViewer` calls this once it has scrolled to (or dropped) an
   *  `initialPdfPosition` — see its own doc comment. */
  clearInitialPdfPosition: () => void
  /**
   * Persists `page` as `paperId`'s reading position, for the next time this
   * project is opened — see `saveReadingPosition`. Takes `paperId` explicitly
   * rather than reading `currentPaperId` off the store: the call is debounced
   * from `PdfViewer`, and by the time it actually fires the reviewer may
   * already have switched to a different paper — writing whichever paper is
   * *current by then* would attribute an old page number to the wrong paper.
   * A no-op with no stable save location (server mode, a browser
   * download-only save): the same case `saveCurrentReviewer` already
   * quietly skips.
   */
  noteReadingPosition: (paperId: string, page: number, offsetFraction: number) => void
  /** Open/close a field's link popover, closing any other field's — see `openLinkPopoverField`. */
  setOpenLinkPopoverField: (canonical: string | null) => void
  /** Set/clear `lastCreatedMarkId` — see its own doc comment. */
  setLastCreatedMarkId: (markId: string | null) => void
  /** Request/clear a "scroll to and flash this field" — see `pendingFieldJump`. */
  setPendingFieldJump: (canonical: string | null) => void
  /** Set/clear the field currently pulsing — see `flashFieldPath`. */
  setFlashFieldPath: (canonical: string | null) => void
  /** Replace the Consolidation overview with Agreement, then restore it on close. */
  openAgreementFromOverview: () => void
  closeAgreement: () => void
  /** Open/close the project-wide Consolidation overview. */
  setConsolidationOverviewOpen: (open: boolean) => void
  /** Open/close the current paper's disagreement list. */
  setDisagreementsOpen: (open: boolean) => void
  /** Open one paper's disagreement list from the project-wide overview. */
  openDisagreementsFromOverview: (paperId: string) => void
  /** Close the paper list, restoring its originating overview when applicable. */
  closeDisagreements: () => void
  /** Look for a newer release (cached; silent when it can't be determined). */
  checkForUpdate: () => Promise<void>
  /** Start downloading the update found by `checkForUpdate`. Win/linux only —
   *  a no-op wherever `checkForNativeUpdate` reports unsupported (mac, browser). */
  downloadUpdate: () => Promise<void>
  /** Quit and install the update `updateReady` confirmed is downloaded. */
  installUpdate: () => Promise<void>
  /** Wired by `useElectronCloseGuard` to the bridge's progress/downloaded/error
   *  events — not meant to be called from UI code directly. */
  noteUpdateProgress: (percent: number) => void
  noteUpdateDownloaded: () => void
  noteUpdateError: (message: string) => void

  setFieldValue: (path: PathSeg[], name: string, index: number, value: FieldValue) => void
  addInstance: (path: PathSeg[], def: ResolvedDef) => void
  removeInstance: (path: PathSeg[], name: string, index: number) => void
  /** Tick/untick "annotation finished" for the current paper and seat — the
   *  checkbox in the annotation panel, and the only thing that turns the
   *  paper list's dot green (see `Paper.finished`). Pushes no history entry
   *  of its own — it is a declaration about the work, not an edit to it, and
   *  a reviewer reaching for undo means "take back what I typed". It still
   *  rides along inside the project snapshots undo/redo restore, exactly like
   *  PDF marks do, so undoing the edit that completed the paper takes the
   *  declaration back with it — which is the coherent outcome, since that
   *  state was neither complete nor declared. */
  setAnnotationFinished: (finished: boolean) => void
  undo: () => void
  redo: () => void

  /** Every mark (highlight, optionally with a comment) on the current paper's
   *  PDF, for whoever is currently reviewing — see `currentMarks`. Empty
   *  outside a paper, or before a reviewer seat is picked on a multi-reviewer
   *  project. */
  currentPdfMarks: () => PdfMark[]
  /** Highlights the selection described by `page`/`rects`, in the color
   *  given (or the first of `MARK_COLORS`) — the standard "select text,
   *  highlight it" a PDF viewer offers. `kind: 'note'` instead pins a sticky
   *  note at `rects[0]`'s point (no text selected) — same storage, same
   *  merge rules, just a different marker in the overlay. Returns the new
   *  mark's id so the caller can open its comment popover right away. Not
   *  part of the annotation undo stack (see `pdfMarks.ts`'s own doc comment
   *  on why marks are a separate, lower-stakes concern from an annotation
   *  answer). */
  addHighlight: (
    page: number,
    rects: MarkRect[],
    color?: string,
    kind?: PdfMark['kind'],
    text?: string,
    /** Set only when this mark is one page-fragment of a highlight that
     *  spans a page boundary — every fragment sharing a `groupId` is kept
     *  in sync (comment/color/links) by the mutating actions below, so a
     *  reviewer sees one logical highlight rendered on multiple pages. */
    groupId?: string,
  ) => string | null
  /** Replaces a mark's comment text (`''` clears it back to a plain highlight
   *  with no note). No-op if `id` isn't a mark on the current paper/reviewer. */
  setMarkComment: (id: string, comment: string) => void
  setMarkColor: (id: string, color: string) => void
  removeMark: (id: string) => void
  /** Link a mark to a field instance as supporting evidence — a no-op if
   *  already linked. */
  linkMarkToField: (markId: string, path: PathSeg[], name: string, index: number) => void
  /** Remove one link by its canonical path. No-op if `markId`/`canonicalPath`
   *  isn't currently linked. */
  unlinkMarkFromField: (markId: string, canonicalPath: string) => void
  /** Write the reviewer-approved AI suggestions into the current paper (one undo step). */
  applyAiSuggestions: (
    suggestions: Suggestion[],
    usage: { provider: string; model: string },
    /** The paper and seat the run was made for — see `AiState.runFor`. */
    target: { paperId: string; reviewer: string | null },
  ) => AiApplyResult
  /** The reviewer looked at an AI-filled field — drop its mark. */
  confirmAiMark: (paperId: string, canonicalPath: string) => void
  /** The hidden gesture landed — allow AI use for the rest of this session. */
  unlockAi: () => void

  /** Switch which reviewer's tree is shown/edited. This is a local view
   * switch, not an edit: no undo step, no `dirty`, and never any JSON write. */
  selectReviewer: (reviewer: string | null) => void
  /** Consolidation clicked "compare" on one field — open the popup for it. */
  openConsolidation: (path: PathSeg[], name: string, index: number, returnToDisagreements?: boolean) => void
  closeConsolidation: () => void
  /** Store a chosen reviewer value and resolve that disagreement in one undo step. */
  resolveConsolidationValue: (path: PathSeg[], name: string, index: number, value: FieldValue) => void
  /** Mark a field for a different, manually entered Consolidation value. */
  deferConsolidationValue: (path: PathSeg[], name: string, index: number) => void
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

  /**
   * Record (or clear) the current paper's screening decision for the active
   * seat, optionally writing the exclusion reason in the *same* undo step
   * (used by the `1`-`9` keyboard shortcuts, which exclude-with-reason in one
   * press — see `useKeybindings.ts`).
   *
   * Changing away from `Exclude` clears the reason as part of the same
   * mutation: a reason without an exclusion is a state the reviewer never
   * chose, and undoing it in two presses would misrepresent what they did.
   *
   * Advances to the next undecided paper only when this seat's decision went
   * from undecided to decided — re-deciding a paper you came back to fix must
   * not jump away from it. That rule lives here, not in the keyboard/button
   * handlers, so they cannot drift apart on it.
   */
  setScreeningDecision: (decision: string | null, reason?: string | null) => void
  /** Record the exclusion reason. No-op unless the seat's current decision is Exclude. */
  setScreeningReason: (reason: string | null) => void
  setScreeningFilter: (filter: ScreeningStatus | 'all') => void
  /** Which annotation state the paper list shows — see `annotationFilter`. */
  setAnnotationFilter: (filter: AnnotationFilter) => void
  toggleScreeningPdf: () => void
  setScreeningSummaryOpen: (open: boolean) => void
  /**
   * Best-effort: read `paperId`'s PDF and fill its `abstract` from
   * `pdfMeta.ts`'s heuristic when it has a PDF but no abstract yet. Fired by
   * `selectPaper` and by `loadFromText` for the paper it opens on — screening
   * is decided from the abstract, so the record view must simply *have* one,
   * without the reviewer opening the PDF to trigger it.
   *
   * Never awaited by its callers: selecting a paper is instant, and a slow or
   * failed read only means the abstract stays empty, exactly as before this
   * existed. Marks what it writes `abstractFromPdf`, so it is shown as the
   * guess it is.
   */
  extractScreeningAbstract: (paperId: string) => Promise<void>
  /**
   * Adopt every paper's unanimous screening decision into the consolidated
   * tree, in one undo step. Returns how many papers were filled.
   *
   * Screening-only, and that is a correctness constraint, not just scope:
   * `adoptUnanimousValues` reads every reviewer at a fixed index, which only
   * means anything once `applyAlignment` has lined their entries up. A
   * screening schema has no repeatable node (`alignableNodes` returns `[]`),
   * so there is nothing to line up and the read is meaningful for every paper
   * at once — for an ordinary schema it would not be, which is why the
   * per-paper scheduler (`useConsolidationAlignment`) exists at all.
   */
  adoptAllUnanimousScreening: () => number
  /**
   * Same idea as `adoptAllUnanimousScreening`, for an ordinary (non-screening)
   * schema: align every paper's reviewers, then adopt what they unanimously
   * agree on, across the whole project. Unlike screening, this schema *can*
   * have repeatable nodes, so — unlike screening — each paper must be aligned
   * immediately before it is read; see `adoptAllUnanimousAnnotations`'s
   * implementation for why the two cannot share one driver.
   *
   * Async and yields between papers (see `UnanimousRun`), because matching a
   * hundred papers in one blocking pass would freeze the window; progress is
   * published to `unanimousRun` rather than returned.
   */
  adoptAllUnanimousAnnotations: () => Promise<void>
  /** Clear the summary `adoptAllUnanimousAnnotations` leaves behind when it finishes. */
  dismissUnanimousRun: () => void
  /** Stop a batch adopt-unanimous run part-way. Called by undo/redo, whose
   *  history entry would otherwise be inconsistent with what the run went on
   *  to write — see the implementation. */
  stopUnanimousRun: () => void
}

/** What `applyAiSuggestions` actually did, for the summary shown to the reviewer. */
export interface AiApplyResult {
  filled: number
  /** Suggestions not written: the field is no longer empty, or the path no longer resolves. */
  skipped: number
}

/** Progress of a running `adoptAllUnanimousAnnotations`. Session-only. */
export interface UnanimousRun {
  done: number
  total: number
  /** Papers that got at least one value. */
  filled: number
  /** Papers left alone because alignment could not vouch for their order. */
  skipped: number
  running: boolean
  /** True when an undo or redo stopped the run part-way, so the summary can
   *  say the totals describe what was adopted before it stopped rather than
   *  the whole project. */
  interrupted?: boolean
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

/**
 * PDF-marks counterpart to `currentTree`: which reviewer's own highlights and
 * comments are shown/edited right now, following the exact same routing —
 * `paper.marks` for a single-reviewer project or the Consolidation seat,
 * `paper.reviewMarks[currentReviewer]` otherwise. Unlike `currentTree`,
 * there's no schema-driven skeleton to normalize into: a reviewer with no
 * marks yet has an empty array, not a missing key, so `create` only ever
 * needs to initialize that key the first time a mark is actually added.
 */
/** Stable empty-array identity for "no marks yet" — returning a fresh `[]`
 *  literal from a Zustand selector makes every snapshot look like a change,
 *  which sends `useSyncExternalStore` into an infinite re-render loop (React:
 *  "Maximum update depth exceeded" / "getSnapshot should be cached"). See
 *  `currentPdfMarks` and `currentMarks` below, the two places this matters. */
const EMPTY_MARKS: PdfMark[] = []

export function currentMarks(
  project: Project,
  currentReviewer: string | null,
  paper: Paper,
  create = false,
): PdfMark[] | null {
  if (project.reviewers <= 1) return paper.marks
  if (currentReviewer === 'consolidation') return paper.marks
  if (currentReviewer === null) return null
  const existing = paper.reviewMarks[currentReviewer]
  if (existing) return existing
  if (!create) return EMPTY_MARKS
  paper.reviewMarks[currentReviewer] = []
  return paper.reviewMarks[currentReviewer]
}

/**
 * `currentTree`'s counterpart for the "finished" declaration: whose checkbox
 * is being shown/toggled right now, following the exact same seat routing —
 * `paper.finished` for a single-reviewer project or the Consolidation seat,
 * `paper.reviewsFinished[currentReviewer]` otherwise, and `null` when nobody
 * has picked a seat (an unattributed declaration is as meaningless as an
 * unattributed edit). Read-only: there is no `create` variant, since the flag
 * has no skeleton to initialise — an absent key already means `false`.
 */
export function currentFinished(
  project: Project,
  currentReviewer: string | null,
  paper: Paper,
): boolean | null {
  if (project.reviewers <= 1) return paper.finished
  if (currentReviewer === 'consolidation') return paper.finished
  if (currentReviewer === null) return null
  return paper.reviewsFinished[currentReviewer] === true
}

/**
 * Which paper a project opens on: the first one this seat has *not* finished,
 * rather than simply the first in the list.
 *
 * Reopening a review in progress should land where the work is. The first
 * paper is only the right answer on a brand-new project — on any project that
 * has been worked through, it is a paper the reviewer already signed off, and
 * landing on it invites re-reading (or re-editing) settled work before
 * getting to what is left.
 *
 * "Not finished" is the dot's own `finished` state (see `annotationState`), so
 * the app lands on the first paper whose dot is not green — including a
 * `flagged` one, which is precisely a paper still needing attention. Falls
 * back to the first paper when every paper is finished (nothing is left to
 * land on, and an empty selection would show "Select a paper to annotate" on
 * a completed review) and wherever the state does not apply at all: a
 * screening project, or a multi-reviewer project with no seat picked yet,
 * where nothing can be attributed and the list opens as it always did.
 *
 * The Consolidation seat is included, having a sign-off of its own
 * (`completenessApplies`): reopening a project as the consolidator lands on the
 * first paper *they* have not signed off, for exactly the reason a reviewer's
 * seat does. `loadCurrentReviewer` restores the seat before this runs, so that
 * happens on the very first render rather than after a seat switch.
 */
function firstUnfinishedPaperId(project: Project, currentReviewer: string | null): string | null {
  const fallback = project.papers[0]?.id ?? null
  const applies = completenessApplies(project)
  if (!applies || (project.reviewers > 1 && currentReviewer === null)) return fallback
  for (const paper of project.papers) {
    const state = annotationStateFor(
      project.schema,
      currentTree(project, currentReviewer, paper),
      currentFinished(project, currentReviewer, paper) === true,
      true,
      project.finishCheckbox,
    )
    if (state !== 'finished') return paper.id
  }
  return fallback
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
    lastSavedAt: null,
    autosaveEnabled: loadAutosaveEnabled(),
    theme: loadTheme(),
    fontScale: loadFontScale(),
    pdfZoom: 1,
    recents: getPlatform().getRecents(),
    helpOpen: false,
    validation: null,
    validationUnannotated: null,
    validationOpen: false,
    agreementOpen: false,
    exportPdfOpen: false,
    schemaInfoOpen: false,
    pendingMarkJump: null,
    initialPdfPosition: null,
    openLinkPopoverField: null,
    lastCreatedMarkId: null,
    lastCreatedMarkAllowedField: null,
    sessionCreatedMarkIds: [],
    pendingFieldJump: null,
    flashFieldPath: null,
    agreementReturnToOverview: false,
    consolidationOverviewOpen: false,
    disagreementsOpen: false,
    disagreementsReturnToOverview: false,
    returnToDisagreements: false,
    unanimousRun: null,
    projectGeneration: 0,
    closePromptOpen: false,
    pendingAfterPrompt: null,
    appVersion: APP_VERSION,
    update: null,
    updateProgress: null,
    updateReady: false,
    updateError: null,
    past: [],
    future: [],
    aiMarks: {},
    deferredConsolidations: {},
    aiUnlocked: false,
    currentReviewer: null,
    consolidationTarget: null,
    screeningFilter: 'all',
    annotationFilter: 'all',
    screeningShowPdf: false,
    screeningSummaryOpen: false,
    screeningAbstractReads: {},

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
          s.pendingAfterPrompt = { kind: 'close' }
        })
        return
      }
      get().closeProject()
    },

    requestOpenProject: () => {
      // Nothing open, or nothing to lose: straight through.
      if (!get().project || !get().dirty) {
        void get().openProject()
        return
      }
      set((s) => {
        s.closePromptOpen = true
        s.pendingAfterPrompt = { kind: 'open' }
      })
    },

    requestOpenRecent: (id) => {
      if (!get().project || !get().dirty) {
        void get().openRecent(id)
        return
      }
      set((s) => {
        s.closePromptOpen = true
        s.pendingAfterPrompt = { kind: 'openRecent', id }
      })
    },

    resolveClosePrompt: async (choice) => {
      const pending = get().pendingAfterPrompt
      if (choice === 'cancel') {
        set((s) => {
          s.closePromptOpen = false
          s.pendingAfterPrompt = null
        })
        return
      }
      if (choice === 'save' && !(await get().save())) {
        // The save failed or was cancelled — keep the project open, and drop
        // the pending action with it: the reviewer asked to save first, and
        // that did not happen.
        set((s) => {
          s.closePromptOpen = false
          s.pendingAfterPrompt = null
        })
        return
      }
      set((s) => {
        s.closePromptOpen = false
        s.pendingAfterPrompt = null
      })
      // `openProject`/`openRecent` replace the open project wholesale
      // (`loadFromText` resets every per-project field), so there is nothing to
      // close first.
      if (pending?.kind === 'open') {
        void get().openProject()
        return
      }
      if (pending?.kind === 'openRecent') {
        void get().openRecent(pending.id)
        return
      }
      get().closeProject()
    },

    closeProject: () => {
      lastFieldKey = null
      projectGeneration++
      set((s) => {
        s.projectGeneration = projectGeneration
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
        s.deferredConsolidations = {}
        s.validation = null
        s.validationUnannotated = null
        s.validationOpen = false
        s.agreementOpen = false
        s.exportPdfOpen = false
        s.schemaInfoOpen = false
        s.pendingMarkJump = null
        s.openLinkPopoverField = null
        s.lastCreatedMarkId = null
        s.lastCreatedMarkAllowedField = null
        s.pendingFieldJump = null
        s.flashFieldPath = null
        s.agreementReturnToOverview = false
        s.consolidationOverviewOpen = false
        s.disagreementsOpen = false
        s.disagreementsReturnToOverview = false
        s.returnToDisagreements = false
        // Also the run's bail-out: a step of `adoptAllUnanimousAnnotations`
        // checks this between papers and stops once it is no longer set.
        s.unanimousRun = null
        s.closePromptOpen = false
        s.pendingAfterPrompt = null
        s.currentReviewer = null
        s.consolidationTarget = null
        s.screeningFilter = 'all'
        s.annotationFilter = 'all'
        s.screeningShowPdf = false
        s.screeningSummaryOpen = false
        s.screeningAbstractReads = {}
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

    loadFromText: (text, handle, name) => {
      try {
        const project = loadProject(text)
        // The seat has to be resolved before the landing paper, since which
        // papers count as finished is per-seat. Same value the `set` below
        // stores; computed once here so the two cannot disagree.
        const reviewer = project.reviewers > 1 ? loadCurrentReviewer(handle, project.reviewers) : null
        // A remembered reading position always wins over the "first
        // unfinished paper" heuristic — that heuristic exists for when there
        // is nothing better to go on (a fresh machine, a project just pulled
        // from git), not to override where the reviewer actually left off.
        // Ignored if the paper it names no longer exists (deleted since, or
        // this is a different project that happens to reuse the same file
        // path — vanishingly rare, but cheap to guard).
        const savedPosition = loadReadingPosition(handle)
        const savedPaperStillExists =
          !!savedPosition && project.papers.some((p) => p.id === savedPosition.paperId)
        const landingPaperId = savedPaperStillExists
          ? savedPosition!.paperId
          : firstUnfinishedPaperId(project, reviewer)
        // The title only becomes known once the JSON is parsed, so the recents
        // entry is enriched here rather than in the adapter's open path.
        if (handle) getPlatform().rememberProject(handle, name, project.title)
        projectGeneration++
        set((s) => {
          s.projectGeneration = projectGeneration
          s.project = project
          s.saveHandle = handle
          s.projectName = name
          s.projectTitle = project.title ?? ''
          s.recents = getPlatform().getRecents()
          s.currentPaperId = landingPaperId
          s.initialPdfPosition =
            savedPaperStillExists && landingPaperId
              ? { paperId: landingPaperId, page: savedPosition!.page, offsetFraction: savedPosition!.offsetFraction }
              : null
          s.dirty = false
          s.loadError = null
          s.busy = false
          s.pdfSelection = ''
          s.past = []
          s.future = []
          // Marks belong to the papers of the project that is going away.
          s.aiMarks = {}
          s.deferredConsolidations = {}
          s.validation = null
          s.validationUnannotated = null
          s.validationOpen = false
          s.agreementOpen = false
          // Opened once per project load, so a reviewer sees it before
          // annotating; dismissible from there via the ⓘ button or the
          // dialog's own close/Okay buttons. Reset (not carried over) here
          // too, unlike `exportPdfOpen`, so switching projects never leaves a
          // stale dialog open or skips a schema comment the new file has.
          s.schemaInfoOpen = !!project.schemaInfo
          s.agreementReturnToOverview = false
          s.consolidationOverviewOpen = false
          s.disagreementsOpen = false
          s.disagreementsReturnToOverview = false
          s.returnToDisagreements = false
          // Also the run's bail-out — see `closeProject`.
          s.unanimousRun = null
          s.consolidationTarget = null
          s.screeningFilter = 'all'
          s.annotationFilter = 'all'
          s.screeningShowPdf = false
          s.screeningSummaryOpen = false
          // Re-derive rather than carry over: a single-reviewer project never
          // has one, and a multi-reviewer project restores whatever was
          // persisted for *this* file (or null — unselected — if there is
          // none, so the reviewer picks explicitly rather than inheriting
          // whoever the previously open project happened to be showing).
          s.currentReviewer = reviewer
          s.screeningAbstractReads = {}
        })
        lastFieldKey = null
        // The paper the project opens on gets the same treatment `selectPaper`
        // gives every one after it — the reviewer never selected this one by
        // hand, so nothing else would ever fire for it.
        if (landingPaperId) void get().extractScreeningAbstract(landingPaperId)
        // Deferred one tick (same `setTimeout(…, 0)` precedent as
        // `yieldToBrowser` below) so the `set` above gets to paint the newly
        // opened project before this runs: `needsShapeMigration` walks every
        // paper's (and, for multi-reviewer, every reviewer's) annotation tree,
        // which is real work on a large file, and its only consequence is
        // deciding whether to kick off the already-fire-and-forget resave
        // below — nothing here needs to happen before the UI shows the project.
        setTimeout(() => {
          const rawData = JSON.parse(text) as unknown
          // `loadProject` already normalizes every paper's `annotations` and
          // (for a multi-reviewer project) backfills a skeleton for every
          // reviewer who has not written anything — see `normalizeReviews`.
          // `needsShapeMigration` asks, structurally, whether the file on disk
          // already had that shape — deliberately *not* a text comparison
          // against the canonical re-serialization, which would also trip on
          // nothing more than whitespace or key order and resave files that
          // were already perfectly fine.
          const needsMigration = needsShapeMigration(project, rawData)
          // Write the migrated shape back in place — never a download, and never
          // a "where should this go" prompt, just because a file's shape needed
          // updating. A project with nowhere stable to write (a `?project=` URL,
          // or a browser pick with no in-place handle) simply keeps the better
          // shape in memory; it converges again, harmlessly, next time it opens.
          if (needsMigration && handle && handle.kind !== 'download') {
            getPlatform()
              .saveProject(serializeProject(project), handle)
              .then((newHandle) => {
                // A second load may have already replaced this project (the user
                // opened something else before this write landed) — in which
                // case the result belongs to a project nobody is looking at
                // anymore, and applying it would resurrect a stale handle.
                if (get().project === project) {
                  set((s) => {
                    s.saveHandle = newHandle
                  })
                }
              })
              .catch(() => {
                // No alarming banner for a fix the reviewer never asked for and
                // has no different action to take — the ordinary unsaved-changes
                // guard already exists for exactly "memory doesn't match disk",
                // and will ask about it the same way any other edit would.
                if (get().project === project) {
                  set((s) => {
                    s.dirty = true
                  })
                }
              })
          }
        }, 0)
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

    resyncProjectFromDisk: async () => {
      const handle = get().saveHandle
      if (!handle?.path) return
      const opened = await getPlatform().openRecent(handle.path)
      if (!opened) return
      try {
        const project = loadProject(opened.text)
        set((s) => {
          s.project = project
          s.saveHandle = opened.handle
          // The undo/redo stacks hold snapshots that branch off the *old*
          // in-memory project — `undo` restores `entry.project` wholesale
          // (see below), so leaving them in place lets a Ctrl+Z after a
          // resync silently discard whatever the disk read just brought in
          // and resurrect a whole-project snapshot from before it. Same
          // reasoning as `loadFromText`'s reset, and for the same reason: the
          // re-read project is not the one these snapshots were taken from.
          s.past = []
          s.future = []
        })
        lastFieldKey = null
      } catch {
        // The file on disk is malformed — leave the in-memory project (still
        // valid) exactly as it was rather than surface a load error for a
        // resync the reviewer never asked for; a real problem here will
        // resurface the next time they actually open/reload the project.
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
        // Nothing blocks input while the write above is in flight (Field.tsx
        // writes every keystroke straight to the store, and screening's I/E/U
        // keys aren't gated on `busy` either), so a reviewer can type a new
        // answer before this promise resolves. That edit already set `dirty`
        // back to `true` for itself; only the snapshot that was actually
        // serialized (`project`, captured above) may clear it, or the toolbar
        // would say "Saved" — and Cmd+Q would not prompt — for an edit that
        // never reached disk. Same guard as the migration write in
        // `loadFromText` above.
        const stillCurrent = get().project === project
        set((s) => {
          s.saveHandle = handle
          if (stillCurrent) s.dirty = false
          s.busy = false
          s.lastSavedAt = Date.now()
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

        // Refuse rather than silently start sharing an `annotations/` folder
        // with another project already in that directory — this is the only
        // moment such a sharing relationship gets created, so it's the only
        // moment it can be caught. `location.path` is Electron-only (the
        // browser build never reaches this at all); no path means nothing to
        // check against.
        if (location.path) {
          const collision = await platform.checkSiblingCollision(
            location.path,
            project.papers.map((p) => p.id),
            project.screening !== null,
          )
          if (collision) {
            set((s) => {
              s.busy = false
              const noun = collision.overlappingIds.length === 1 ? 'a paper' : 'papers'
              s.loadError = {
                message:
                  `Can't save here — "${collision.siblingName}" in this folder already shares ${noun} ` +
                  "with this project and uses the same annotation files, so saving here would let the " +
                  "two projects silently overwrite each other's answers. Choose a different folder.",
                details: [
                  `Shared paper id${collision.overlappingIds.length === 1 ? '' : 's'}: ${collision.overlappingIds.join(', ')}`,
                ],
              }
            })
            return false
          }
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
        // Same carry-over for the reading position, or reopening the file at
        // its new location would land on the "first unfinished paper" default
        // instead of wherever the reviewer actually was.
        const oldPosition = loadReadingPosition(saveHandle)
        if (oldPosition) {
          saveReadingPosition(handle, oldPosition.paperId, oldPosition.page, oldPosition.offsetFraction)
        }
        // Drop undo history *only when the PDF paths actually moved*. Its
        // snapshots hold `paper.pdf` relative to the old location, so undoing
        // after a rebase would restore now-broken paths (and, since undo sets
        // `dirty`, re-save them). But `toWrite === project` means nothing was
        // rebased — no `saveHandle` yet (a plain first Ctrl+S delegates here),
        // or a browser adapter that returns the paths unchanged — and there the
        // snapshots are still valid. Clearing unconditionally would silently
        // wipe the undo stack on an ordinary first save, which plain Save has
        // never done.
        const pathsMoved = toWrite !== project
        if (pathsMoved) lastFieldKey = null
        // Same race as `save()`, plus a second hazard: `toWrite` is a copy of
        // the pre-await `project` with only its PDF paths changed, so
        // unconditionally assigning it to `s.project` would also erase an
        // edit made during the awaits above, not just leave `dirty` wrong
        // about it. Adopt `toWrite` (and clear dirty / drop history) only if
        // nothing else landed in the meantime; otherwise the newer project
        // already in the store is the one with the edit, and it genuinely
        // has not been saved anywhere yet.
        const stillCurrent = get().project === project
        set((s) => {
          s.saveHandle = handle
          s.projectName = location.name
          s.busy = false
          s.lastSavedAt = Date.now()
          s.recents = platform.getRecents()
          if (stillCurrent) {
            s.project = toWrite
            s.dirty = false
            if (pathsMoved) {
              s.past = []
              s.future = []
            }
          }
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
        // Belongs to the paper it was made on — carrying it to a different
        // one risks auto-linking a much later click to a mark the reviewer
        // has long since stopped thinking about.
        s.lastCreatedMarkId = null
        s.lastCreatedMarkAllowedField = null
      })
      // Screening reads the abstract, so a screening paper that has none needs
      // one *here* — by the time the reviewer is looking at the record view,
      // not only if they go on to open the PDF. Fire-and-forget: the selection
      // above is already done, and every guard lives in the action itself.
      void get().extractScreeningAbstract(id)
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

    setAutosaveEnabled: (enabled) => {
      saveAutosaveEnabled(enabled)
      set((s) => {
        s.autosaveEnabled = enabled
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
      // `screeningIssues` does its own seat routing over the *original*
      // project (not the remapped `papers` above), since it reads both the
      // decision and the reason at once rather than a single active tree.
      const allIssues = project.screening
        ? [...issues, ...screeningIssues(project, currentReviewer)]
        : issues
      set((s) => {
        s.validation = allIssues
        s.validationUnannotated = unannotated
        s.validationOpen = true
      })
    },

    setValidationOpen: (open) =>
      set((s) => {
        s.validationOpen = open
      }),

    setAgreementOpen: (open) =>
      set((s) => {
        s.agreementOpen = open
        if (!open) s.agreementReturnToOverview = false
      }),

    setExportPdfOpen: (open) =>
      set((s) => {
        s.exportPdfOpen = open
      }),

    setSchemaInfoOpen: (open) =>
      set((s) => {
        s.schemaInfoOpen = open
      }),

    setPendingMarkJump: (markId) =>
      set((s) => {
        s.pendingMarkJump = markId
      }),

    clearInitialPdfPosition: () =>
      set((s) => {
        s.initialPdfPosition = null
      }),

    noteReadingPosition: (paperId, page, offsetFraction) => {
      saveReadingPosition(get().saveHandle, paperId, page, offsetFraction)
    },

    setOpenLinkPopoverField: (canonical) =>
      set((s) => {
        s.openLinkPopoverField = canonical
      }),

    setLastCreatedMarkId: (markId) =>
      set((s) => {
        s.lastCreatedMarkId = markId
        s.lastCreatedMarkAllowedField = null
      }),

    setPendingFieldJump: (canonical) =>
      set((s) => {
        s.pendingFieldJump = canonical
      }),

    setFlashFieldPath: (canonical) =>
      set((s) => {
        s.flashFieldPath = canonical
      }),

    openAgreementFromOverview: () =>
      set((s) => {
        s.consolidationOverviewOpen = false
        s.agreementOpen = true
        s.agreementReturnToOverview = true
      }),

    closeAgreement: () =>
      set((s) => {
        s.agreementOpen = false
        s.consolidationOverviewOpen = s.agreementReturnToOverview
        s.agreementReturnToOverview = false
      }),

    setConsolidationOverviewOpen: (open) =>
      set((s) => {
        s.consolidationOverviewOpen = open
      }),

    setDisagreementsOpen: (open) =>
      set((s) => {
        s.disagreementsOpen = open
      }),

    openDisagreementsFromOverview: (paperId) => {
      // Jumping to another paper: reset the coalescing key, or the next edit to
      // the same field would fold into the undo entry of the paper we left —
      // one Undo would then wipe both papers' answers.
      lastFieldKey = null
      set((s) => {
        if (!s.project?.papers.some((paper) => paper.id === paperId)) return
        s.currentPaperId = paperId
        s.pdfSelection = ''
        s.consolidationOverviewOpen = false
        s.disagreementsOpen = true
        s.disagreementsReturnToOverview = true
      })
    },

    closeDisagreements: () =>
      set((s) => {
        s.disagreementsOpen = false
        s.consolidationOverviewOpen = s.disagreementsReturnToOverview
        s.disagreementsReturnToOverview = false
      }),

    checkForUpdate: async () => {
      const cached = readUpdateCache()
      // Called on every startup so an update notice shows up promptly, not
      // once a day — the short-lived cache below only absorbs a rapid
      // crash-restart loop, it isn't meant to skip real day-to-day launches.
      if (cached) {
        set((s) => {
          s.update = updateFrom(APP_VERSION, cached.release)
        })
      } else {
        const release = await fetchLatestRelease(getPlatform().getOsInfo())
        writeUpdateCache(release)
        set((s) => {
          s.update = updateFrom(APP_VERSION, release)
        })
      }
      // Only ask electron-updater's own feed whether it can actually download
      // something once the GitHub-API check above has already confirmed a
      // newer version exists — that check stays the single source of truth
      // for "is there an update"; this one only ever drives the download
      // mechanics on win/linux (mac reports { supported: false }, see
      // electron/main.ts). Never triggers a download by itself.
      if (get().update && getPlatform().getOsInfo()?.platform !== 'darwin') {
        void getPlatform().checkForNativeUpdate()
      }
    },

    downloadUpdate: async () => {
      set((s) => {
        s.updateError = null
      })
      await getPlatform().downloadNativeUpdate()
    },

    installUpdate: async () => {
      await getPlatform().installNativeUpdate()
    },

    noteUpdateProgress: (percent) =>
      set((s) => {
        s.updateProgress = percent
      }),

    noteUpdateDownloaded: () =>
      set((s) => {
        s.updateProgress = 100
        s.updateReady = true
      }),

    noteUpdateError: (message) =>
      set((s) => {
        s.updateError = message
        s.updateProgress = null
      }),

    setFieldValue: (path, name, index, value) => {
      const prev = get()
      if (!prev.project) return
      // Multi-reviewer, nobody picked yet: nothing to attribute this edit to.
      if (prev.project.reviewers > 1 && prev.currentReviewer === null) return
      // Collapse consecutive edits of the same field into one undo step.
      const key = `${JSON.stringify(path)}|${name}|${index}`
      const coalesce = key === lastFieldKey
      lastFieldKey = key
      const canonical = fieldPath(path, name, index)
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
        noteFieldTouchForPendingMarkLink(s, canonical)
        if (s.currentReviewer === 'consolidation') {
          if (isDeferredValueEmpty(value)) {
            // A consolidation-seat write that leaves the field empty must not
            // leave it flagged "the reviewers' answers mean the same thing" —
            // see `closingWouldStrand`'s own comment for the failure this
            // avoids: the field would read as resolved everywhere while
            // holding no answer, and nothing would ever surface it again.
            // `closingWouldStrand` only guards the compare popup's own close
            // path; this covers every other way a consolidation write can
            // empty a field afterward (an ordinary in-panel edit, say).
            const i = paper.equal.indexOf(canonical)
            if (i >= 0) paper.equal.splice(i, 1)
          } else {
            // Picking a value for a field that was deferred settles it, but
            // does not by itself mean the reviewers agreed — only the
            // explicit "these answers mean the same thing" checkbox
            // (`toggleFieldEquality`) may set `equal`. This just clears the
            // now-satisfied deferral.
            const deferredKey = deferredConsolidationKey(paper.id, canonical)
            if (s.deferredConsolidations[deferredKey]) delete s.deferredConsolidations[deferredKey]
          }
        }
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
          clearPendingMarkLink(s)
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
          clearPendingMarkLink(s)
          s.dirty = true

          // Every other structure addresses a field instance by canonical
          // path with an embedded index, so removing anything but the last
          // entry has to shift the survivors' indices too — otherwise a
          // mark linked to entry #3 keeps pointing at whatever now sits in
          // slot #3 instead of following the entry it was actually about.
          const marks = currentMarks(s.project!, s.currentReviewer, paper, false) ?? EMPTY_MARKS
          for (const mark of marks) {
            if (!mark.linkedFields) continue
            let changed = false
            const next: typeof mark.linkedFields = []
            for (const link of mark.linkedFields) {
              const shifted = shiftCanonicalPath(link.path, path, name, index)
              if (shifted === null) {
                changed = true
                continue
              }
              if (shifted !== link.path) {
                const segs = parsePath(shifted)
                next.push({ path: shifted, label: segs ? displayPath(segs) : link.label })
                changed = true
              } else {
                next.push(link)
              }
            }
            if (changed) {
              if (next.length === 0) delete mark.linkedFields
              else mark.linkedFields = next
              mark.updatedAt = new Date().toISOString()
            }
          }

          const scope = markReviewerScope(s.project!, s.currentReviewer)
          const prefix = aiMarkKey(paper.id, '', scope)
          for (const key of Object.keys(s.aiMarks)) {
            if (!key.startsWith(prefix)) continue
            const canonical = key.slice(prefix.length)
            const shifted = shiftCanonicalPath(canonical, path, name, index)
            if (shifted === canonical) continue
            delete s.aiMarks[key]
            if (shifted !== null) s.aiMarks[aiMarkKey(paper.id, shifted, scope)] = true
          }

          if (s.project!.reviewers <= 1 || s.currentReviewer === 'consolidation') {
            for (let i = 0; i < paper.equal.length; i++) {
              const shifted = shiftCanonicalPath(paper.equal[i], path, name, index)
              if (shifted !== paper.equal[i]) {
                if (shifted === null) paper.equal.splice(i, 1), i--
                else paper.equal[i] = shifted
              }
            }
            // `deferredConsolidations` is session state kept outside the undo
            // snapshot, so an undo of this removal leaves its keys shifted —
            // pre-existing behavior, out of scope here.
            const dcPrefix = `${paper.id}::`
            for (const key of Object.keys(s.deferredConsolidations)) {
              if (!key.startsWith(dcPrefix)) continue
              const canonical = key.slice(dcPrefix.length)
              const shifted = shiftCanonicalPath(canonical, path, name, index)
              if (shifted === canonical) continue
              delete s.deferredConsolidations[key]
              if (shifted !== null) s.deferredConsolidations[`${dcPrefix}${shifted}`] = true
            }
          }

          // `paper.alignment` records which reviewer's own array index sits in
          // which consolidated slot. The splice above just shifted every
          // survivor's real index down by one, and nothing above has told
          // `alignment` that happened — left alone, every slot at or above the
          // removed one keeps pointing at the entry that used to live there.
          // A reviewer's later edit then gets attributed to the wrong slot in
          // every compare popup, or — for the consolidator's own deletion of a
          // consolidated entry — a later "adopt this answer" click can
          // overwrite one finding's text with a different finding's, and a
          // shifted `paper.equal` index marks the wrong pairing "equivalent".
          // Single-reviewer projects never populate `alignment` at all (see
          // its own doc comment), so there is nothing to fix there.
          if (s.project!.reviewers > 1 && s.currentReviewer !== null) {
            if (s.currentReviewer === 'consolidation') {
              // The consolidated array is only ever grown in slot order
              // (`growConsolidated`), never reordered, so the removed
              // consolidated index *is* the slot position at every level —
              // dropping that slot keeps the rest tracking the shrunk array,
              // exactly like the splice above did for the array itself.
              const slots = alignmentSlotsAt(paper.alignment, path, name, (_slots, seg) => seg.index)
              if (slots && index >= 0 && index < slots.length) slots.splice(index, 1)
            } else {
              // A reviewer removed one of their own entries. `members[reviewer]`
              // is their array index, so the same rule `paper.equal`'s indices
              // follow above applies per reviewer instead of per canonical path:
              // drop the entry that named the removed index, decrement every
              // one above it.
              const reviewer = s.currentReviewer
              const slots = alignmentSlotsAt(paper.alignment, path, name, (levelSlots, seg) =>
                levelSlots.findIndex((slot) => slot.members[reviewer] === seg.index),
              )
              if (slots) {
                for (const slot of slots) {
                  const at = slot.members[reviewer]
                  if (at === undefined) continue
                  if (at === index) delete slot.members[reviewer]
                  else if (at > index) slot.members[reviewer] = at - 1
                }
              }
            }
          }
        }
      })
    },

    setAnnotationFinished: (finished) => {
      const prev = get()
      if (!prev.project) return
      // The project decides "done" from the data, so there is no declaration
      // to make (`config.finishCheckbox: false`). The panel hides the
      // checkbox too; this guards the action itself, so a stale click or a
      // future caller cannot write a flag the project has said it ignores.
      if (!prev.project.finishCheckbox) return
      // Multi-reviewer, nobody picked yet: nothing to attribute the
      // declaration to — the same guard every editing action uses.
      if (prev.project.reviewers > 1 && prev.currentReviewer === null) return
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        const project = s.project!
        if (project.reviewers <= 1 || s.currentReviewer === 'consolidation') {
          if (paper.finished === finished) return
          paper.finished = finished
        } else {
          const reviewer = s.currentReviewer!
          if ((paper.reviewsFinished[reviewer] === true) === finished) return
          // Deleted rather than set to `false`: absent *is* the undeclared
          // state (see `parseReviewsFinished`), so unticking has to leave the
          // file exactly as it was before the box was ever ticked.
          if (finished) paper.reviewsFinished[reviewer] = true
          else delete paper.reviewsFinished[reviewer]
        }
        s.dirty = true
      })
    },

    currentPdfMarks: () => {
      const s = get()
      if (!s.project) return EMPTY_MARKS
      const paper = currentPaper(s)
      if (!paper) return EMPTY_MARKS
      return currentMarks(s.project, s.currentReviewer, paper, false) ?? EMPTY_MARKS
    },

    addHighlight: (page, rects, color, kind, text, groupId) => {
      const prev = get()
      if (!prev.project || rects.length === 0) return null
      if (prev.project.reviewers > 1 && prev.currentReviewer === null) return null
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const now = new Date().toISOString()
      // Its own undo step, like every other mark mutation below — without
      // this, Ctrl+Z right after drawing a highlight had no snapshot to pop
      // and silently undid whatever *earlier* edit was last recorded instead.
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      lastFieldKey = null
      set((s) => {
        const paper = currentPaper(s)
        if (!paper) return
        const marks = currentMarks(s.project!, s.currentReviewer, paper, true)
        if (!marks) return
        pushPast(s, snap)
        marks.push({
          id,
          page,
          rects,
          color: color ?? MARK_COLORS[0],
          comment: '',
          text,
          createdAt: now,
          updatedAt: now,
          kind: kind ?? 'highlight',
          groupId,
        })
        s.sessionCreatedMarkIds.push(id)
        s.dirty = true
      })
      return id
    },

    setMarkComment: (id, comment) => {
      const prev = get()
      if (!prev.project) return
      // Typed character by character, like a field value — collapse a run of
      // keystrokes into the mark's own single undo step rather than one per
      // character. Sharing `lastFieldKey` (keyed distinctly, `mark-comment:id`)
      // means every other coalescable edit already resets it correctly:
      // moving to a different field, a different mark, or any other mark
      // mutation below all break the run, same as they already do for
      // `setFieldValue`'s own coalescing.
      const key = `mark-comment:${id}`
      const coalesce = key === lastFieldKey
      lastFieldKey = key
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      set((s) => {
        const paper = currentPaper(s)
        if (!paper || !s.project) return
        const marks = currentMarks(s.project, s.currentReviewer, paper, false)
        const mark = marks?.find((m) => m.id === id)
        if (!mark) return
        if (!coalesce) pushPast(s, snap)
        const now = new Date().toISOString()
        mark.comment = comment
        mark.updatedAt = now
        if (mark.groupId) {
          for (const m of marks!) {
            if (m.id !== mark.id && m.groupId === mark.groupId) {
              m.comment = comment
              m.updatedAt = now
            }
          }
        }
        clearPendingMarkLink(s)
        s.dirty = true
      })
    },

    setMarkColor: (id, color) => {
      const prev = get()
      if (!prev.project) return
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      set((s) => {
        const paper = currentPaper(s)
        if (!paper || !s.project) return
        const marks = currentMarks(s.project, s.currentReviewer, paper, false)
        const mark = marks?.find((m) => m.id === id)
        if (!mark) return
        pushPast(s, snap)
        lastFieldKey = null
        const now = new Date().toISOString()
        mark.color = color
        mark.updatedAt = now
        if (mark.groupId) {
          for (const m of marks!) {
            if (m.id !== mark.id && m.groupId === mark.groupId) {
              m.color = color
              m.updatedAt = now
            }
          }
        }
        clearPendingMarkLink(s)
        s.dirty = true
      })
    },

    removeMark: (id) => {
      const prev = get()
      if (!prev.project) return
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      set((s) => {
        const paper = currentPaper(s)
        if (!paper || !s.project) return
        const marks = currentMarks(s.project, s.currentReviewer, paper, false)
        if (!marks) return
        const mark = marks.find((m) => m.id === id)
        if (!mark) return
        pushPast(s, snap)
        lastFieldKey = null
        const groupId = mark.groupId
        for (let i = marks.length - 1; i >= 0; i--) {
          if (marks[i].id === id || (groupId && marks[i].groupId === groupId)) marks.splice(i, 1)
        }
        clearPendingMarkLink(s)
        s.dirty = true
      })
    },

    // Also how the field-link popover's own auto-link offer (see
    // `lastCreatedMarkId`) is fulfilled — that call lands here like any
    // other, and `clearPendingMarkLink` below consuming the offer as a side
    // effect is exactly the "offered once" behavior it is supposed to have.
    linkMarkToField: (markId, path, name, index) => {
      const prev = get()
      if (!prev.project) return
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      set((s) => {
        const paper = currentPaper(s)
        if (!paper || !s.project) return
        const marks = currentMarks(s.project, s.currentReviewer, paper, false)
        const mark = marks?.find((m) => m.id === markId)
        if (!mark) return
        pushPast(s, snap)
        lastFieldKey = null
        const canonical = fieldPath(path, name, index)
        const label = displayPath([...path, { name, index }])
        const now = new Date().toISOString()
        const group = mark.groupId ? marks!.filter((m) => m.groupId === mark.groupId) : [mark]
        for (const m of group) {
          if (!m.linkedFields) m.linkedFields = []
          if (m.linkedFields.some((l) => l.path === canonical)) continue
          m.linkedFields.push({ path: canonical, label })
          m.updatedAt = now
        }
        clearPendingMarkLink(s)
        s.dirty = true
      })
    },

    unlinkMarkFromField: (markId, canonicalPath) => {
      const prev = get()
      if (!prev.project) return
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      set((s) => {
        const paper = currentPaper(s)
        if (!paper || !s.project) return
        const marks = currentMarks(s.project, s.currentReviewer, paper, false)
        const mark = marks?.find((m) => m.id === markId)
        if (!mark) return
        pushPast(s, snap)
        lastFieldKey = null
        const now = new Date().toISOString()
        const group = mark.groupId ? marks!.filter((m) => m.groupId === mark.groupId) : [mark]
        for (const m of group) {
          if (!m.linkedFields) continue
          const i = m.linkedFields.findIndex((l) => l.path === canonicalPath)
          if (i === -1) continue
          m.linkedFields.splice(i, 1)
          if (m.linkedFields.length === 0) delete m.linkedFields
          m.updatedAt = now
        }
        clearPendingMarkLink(s)
        s.dirty = true
      })
    },

    applyAiSuggestions: (suggestions, usage, target) => {
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
      // Screening decides the review's corpus. A model's include/exclude pass
      // is the difference between a systematic review and a generated one —
      // and the screening panel renders no AI button at all, so the only way
      // here is to open the dialog on another project and switch. Refuse that
      // too, rather than trust the UI to be the whole guard (same reasoning
      // as the Consolidation refusal above).
      if (prev.project.screening !== null) {
        return { filled: 0, skipped: suggestions.length }
      }
      const schema = prev.project.schema
      // The paper and seat the model was *asked about*, not whichever is
      // selected now. The dialog stays open and the paper list and seat picker
      // stay usable while a call is in flight, so those can differ — and
      // writing a reply about paper A onto paper B is fabricated data on a
      // paper nobody read, complete with an `aiUsage` record vouching for it.
      // Refuse rather than guess: the reviewer still has the reply on screen
      // and can go back to the right paper.
      // Refuse on any mismatch rather than quietly retargeting. Writing to the
      // run's paper while the reviewer looks at a different one would be
      // correct attribution but invisible work — they would see "applied" and
      // no change. Refusing keeps the reply on screen so they can go back to
      // the right paper and apply it there.
      if (target.paperId !== prev.currentPaperId) {
        return { filled: 0, skipped: suggestions.length }
      }
      if (target.reviewer !== prev.currentReviewer) {
        return { filled: 0, skipped: suggestions.length }
      }
      const paperNow = prev.project.papers.find((p) => p.id === target.paperId)
      if (!paperNow) return { filled: 0, skipped: suggestions.length }
      // Read-only: the seat the run was made for is who "answered already" is
      // checked against — see `currentTree`.
      const readTree = currentTree(prev.project, target.reviewer, paperNow)
      if (!readTree) return { filled: 0, skipped: suggestions.length }

      // Decide what to write *before* touching anything, so a run that turns out to
      // change nothing leaves no empty entry on the undo stack. A suggestion is
      // dropped if its path no longer resolves, or if the field has since been
      // answered — the reviewer's own work is never overwritten.
      const accepted = suggestions.flatMap((sug) => {
        const at = resolvePath(schema, sug.path, { maxUnboundedIndex: MAX_UNBOUNDED_INDEX })
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
      const reviewerScope = markReviewerScope(prev.project, target.reviewer)
      let filled = 0
      set((s) => {
        // Resolved by id, and against the run's seat — the same target the
        // read above checked. Re-deriving either from "what is current" here
        // would reopen the gap the check exists to close.
        const paper = s.project?.papers.find((p) => p.id === paperId)
        if (!paper) return
        const writeTree = currentTree(s.project!, target.reviewer, paper, true)
        if (!writeTree) return
        pushPast(s, snap)
        for (const { at, value } of accepted) {
          // The model may address an entry of a repeatable node that does not exist
          // yet — that is how it records a further Finding. Create the instances it
          // named, along the whole path.
          let level: ResolvedDef[] = s.project!.schema
          let cursor: AnnotationValueTree | null = writeTree
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
        // A bulk write across however many fields the model addressed, not the
        // one-field edit `lastCreatedMarkId` stays alive through.
        clearPendingMarkLink(s)
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
      // persisted local selection and the visible state change.
      //
      // Break undo-coalescing across the seat change, exactly as `selectPaper`
      // and every mutator do. The coalescing key is field-path only (no seat),
      // so without this an edit to the same field as the new reviewer would
      // glue onto the previous reviewer's undo step — one Undo would then wipe
      // both reviewers' answers, and a subsequent edit clears `future`, losing
      // the first reviewer's value for good.
      lastFieldKey = null
      saveCurrentReviewer(get().saveHandle, reviewer)
      set((s) => {
        s.currentReviewer = reviewer
        // Marks are per-seat too (`reviewMarks`) — a mark just made under one
        // reviewer isn't even visible under another's, so there is nothing
        // for a later popover to auto-link.
        s.lastCreatedMarkId = null
        s.lastCreatedMarkAllowedField = null
      })
    },

    openConsolidation: (path, name, index, returnToDisagreements = false) =>
      set((s) => {
        s.consolidationTarget = { path, name, index }
        s.returnToDisagreements = returnToDisagreements
      }),

    closeConsolidation: () =>
      set((s) => {
        s.consolidationTarget = null
        s.disagreementsOpen = s.returnToDisagreements
        s.returnToDisagreements = false
      }),

    resolveConsolidationValue: (path, name, index, value) => {
      const prev = get()
      const paper = currentPaper(prev)
      if (!prev.project || !paper || prev.currentReviewer !== 'consolidation') return
      const canonical = fieldPath(path, name, index)
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      lastFieldKey = null
      set((s) => {
        const draft = currentPaper(s)
        if (!draft) return
        const container = containerAt(draft.annotations, path)
        const inst = container[name]?.[index]
        if (!inst) return
        pushPast(s, snap)
        inst.value = value
        noteFieldTouchForPendingMarkLink(s, canonical)
        // Picking a reviewer's answer settles the field — it is the normal,
        // routine act of consolidating — but it does not mean the reviewers
        // agreed. Only the explicit "these answers mean the same thing"
        // checkbox (`toggleFieldEquality`) may set `equal`; folding every
        // resolved disagreement into it here silently inflated every
        // agreement statistic the feature exists to report honestly.
        delete s.deferredConsolidations[deferredConsolidationKey(draft.id, canonical)]
        s.dirty = true
      })
    },

    deferConsolidationValue: (path, name, index) => {
      const state = get()
      const paper = currentPaper(state)
      if (!paper || state.currentReviewer !== 'consolidation') return
      const canonical = fieldPath(path, name, index)
      const key = deferredConsolidationKey(paper.id, canonical)
      if (state.deferredConsolidations[key]) return
      set((s) => {
        s.deferredConsolidations[key] = true
        clearPendingMarkLink(s)
      })
    },

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
      // That freeze must protect *existing* pairings, not lock out a reviewer
      // who simply has no assignment yet — one added to the project after the
      // freeze, or one who had not started this paper when it happened. Their
      // real answers exist in their own tree but, with no way to widen a frozen
      // node, never got placed into any consolidated slot, and dropped out of
      // unanimity checks and agreement stats. So a frozen node still runs
      // `widenAlignment` below instead of returning outright — it only ever
      // adds a reviewer absent from every slot's `members`, never moves one
      // already there.
      const frozen = consolidatorHasAnswered(def, paper.annotations)

      // Only the numbered reviewers get a vote, and only the ones who have
      // actually written something. The consolidated tree is what is being
      // built out of them, so letting it match against itself would be
      // circular — and every reviewer now has a tree from the moment the
      // project is loaded (see `normalizeReviews`), empty or not, so presence
      // alone no longer distinguishes "has an opinion" from "has not started".
      const reviews: Record<string, AnnotationValueTree> = {}
      for (let i = 1; i <= project.reviewers; i++) {
        const tree = paper.reviews[String(i)]
        if (tree && hasAnnotations(project.schema, tree)) reviews[String(i)] = tree
      }
      if (Object.keys(reviews).length < 2) return false

      // Computed against the current (frozen) state before opening a draft: this
      // is the expensive part, and immer drafts are not worth proxying it through.
      let nodeStored: StoredSlot[]
      let treeForGrow: TreeAlignment
      if (frozen) {
        const widened = widenAlignment([def], { [nodeName]: paper.alignment[nodeName] ?? [] }, reviews, new Map())
        if (!widened.changed) return false
        nodeStored = widened.alignment[nodeName] ?? []
        treeForGrow = storedAsTreeAlignment(widened.alignment)
      } else {
        const alignment = alignNode(project.schema, reviews, nodeName)
        nodeStored = toStoredAlignment(alignment)[nodeName] ?? []
        treeForGrow = alignment
      }
      const snap: HistoryEntry = { project, paperId: prev.currentPaperId }

      let changed = false
      set((s) => {
        const draft = s.project!.papers.find((p) => p.id === paperId)
        if (!draft) return

        // Nothing here touches `draft.reviews`. Recording who matched whom no
        // longer means rewriting the reviewers' own entries into slot order,
        // so a reviewer's list stays exactly as they left it — which is also
        // why the linked-mark and AI-mark canonical paths that used to be
        // re-pointed here need no fixing up at all any more: they still name
        // the index they always named.
        const mappingChanged = !deepEqualJson(draft.alignment[nodeName], nodeStored)
        const grew = growConsolidated(s.project!.schema, treeForGrow, draft.annotations)
        changed = mappingChanged || grew
        if (!changed) return

        if (mappingChanged) draft.alignment[nodeName] = nodeStored

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

      // Every numbered reviewer, by number — `unanimousFills` decides "answered"
      // per field via `isUnanswered`, not by whether a tree exists at all, so an
      // all-empty (never-touched) tree and a genuinely absent one read the same
      // to it either way.
      const reviews: Record<string, AnnotationValueTree | undefined> = {}
      for (let i = 1; i <= project.reviewers; i++) reviews[String(i)] = paper.reviews[String(i)]

      // Through the mapping, not raw: `unanimousFills` reads every reviewer at
      // one index, which only means "the same entry" in slot space. Before the
      // reviewers' arrays stopped being permuted this was true of the stored
      // data itself; now the lined-up view has to be asked for explicitly.
      const fills = unanimousFills(
        project.schema,
        alignedReviews(project.schema, paper.alignment, reviews),
        paper.annotations,
      )
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
        clearPendingMarkLink(s)
        s.dirty = true
      })
    },

    setScreeningDecision: (decision, reason) => {
      const prev = get()
      if (!prev.project) return
      if (prev.project.reviewers > 1 && prev.currentReviewer === null) return
      const paper = currentPaper(prev)
      if (!paper) return
      // Read *before* mutating: whether this seat had no decision yet is what
      // decides whether to auto-advance below, and it must reflect the state
      // the reviewer actually saw, not the one this call is about to write.
      const readTree = currentTree(prev.project, prev.currentReviewer, paper)
      const wasUndecided = screeningStatus(readTree) === 'undecided'

      lastFieldKey = null
      const snap: HistoryEntry = { project: prev.project, paperId: prev.currentPaperId }
      const paperId = paper.id
      set((s) => {
        const draft = currentPaper(s)
        if (!draft) return
        const tree = currentTree(s.project!, s.currentReviewer, draft, true)
        if (!tree) return
        const decisionInst = tree[SCREENING_DECISION]?.[0]
        if (!decisionInst) return
        pushPast(s, snap)
        decisionInst.value = decision
        // A reason without an exclusion is a state the reviewer never chose —
        // clear it in the same mutation, so undoing the decision also undoes
        // the reason it stops making sense to keep. When excluding with a
        // reason supplied (the `1`-`9` shortcuts), write both here rather than
        // as a second call: a second call would land on whatever paper
        // auto-advance just moved to, not this one.
        const reasonInst = tree[SCREENING_REASON]?.[0]
        if (reasonInst) {
          if (decision !== DECISION_EXCLUDE) reasonInst.value = null
          else if (reason !== undefined) reasonInst.value = reason
        }
        s.dirty = true
      })

      if (wasUndecided && decision !== null) {
        const project = get().project
        const reviewer = get().currentReviewer
        if (!project) return
        const idx = project.papers.findIndex((p) => p.id === paperId)
        for (let i = idx + 1; i < project.papers.length; i++) {
          const candidate = project.papers[i]
          if (screeningStatus(currentTree(project, reviewer, candidate)) === 'undecided') {
            get().selectPaper(candidate.id)
            break
          }
        }
      }
    },

    setScreeningReason: (reason) => {
      const prev = get()
      if (!prev.project) return
      const paper = currentPaper(prev)
      if (!paper) return
      // Only meaningful once the seat's own decision is Exclude — an ordinary
      // field write otherwise, so delegate to `setFieldValue` for the routing,
      // coalescing, undo and dirty-flagging it already does.
      const tree = currentTree(prev.project, prev.currentReviewer, paper)
      if (screeningStatus(tree) !== 'excluded') return
      get().setFieldValue([], SCREENING_REASON, 0, reason)
    },

    setScreeningFilter: (filter) =>
      set((s) => {
        s.screeningFilter = filter
      }),

    setAnnotationFilter: (filter) =>
      set((s) => {
        s.annotationFilter = filter
      }),

    toggleScreeningPdf: () =>
      set((s) => {
        s.screeningShowPdf = !s.screeningShowPdf
      }),

    setScreeningSummaryOpen: (open) =>
      set((s) => {
        s.screeningSummaryOpen = open
      }),

    extractScreeningAbstract: async (paperId) => {
      const project = get().project
      if (!project || project.screening === null) return
      const paper = project.papers.find((p) => p.id === paperId)
      if (!paper || !paper.pdf || paper.abstract) return
      // Already reading it, or already read it and found nothing this session.
      if (get().screeningAbstractReads[paperId]) return

      const generation = projectGeneration
      set((s) => {
        s.screeningAbstractReads[paperId] = 'reading'
      })
      try {
        // Same source the viewer itself renders — works unchanged in both
        // runtimes (slr-file:// in Electron, blob:/http in the browser). See
        // aiStore.ts's `run()` for the identical pattern reading PDF bytes
        // outside of PdfViewer's own rendering.
        const src = await getPlatform().getPdfSource(paper.pdf, get().saveHandle ?? { kind: 'download' })
        let bytes: ArrayBuffer
        try {
          bytes = await (await fetch(src.url)).arrayBuffer()
        } finally {
          src.revoke?.()
        }
        const meta = await extractPdfMeta(bytes)
        if (!meta.abstract) return

        // Staleness is only about the project being *gone*, not about the
        // selection or any edit since: this abstract belongs to `paperId`
        // whether or not the reviewer has moved on or decided something
        // meanwhile, so a late result is still written rather than wasted.
        // See `projectGeneration` for why this is not a reference check.
        if (projectGeneration !== generation) return
        set((s) => {
          // The read *did* find an abstract, so this PDF must never end up
          // marked `'none'` — that means "there is nothing in this PDF to
          // find", and would wrongly block a later retry. Cleared before the
          // write below, which may still decline.
          delete s.screeningAbstractReads[paperId]
          const target = s.project?.papers.find((p) => p.id === paperId)
          // Re-checked inside the producer: something else may have supplied an
          // abstract — a hand edit — while this read was in flight.
          if (!target || target.abstract) return
          target.abstract = meta.abstract
          target.abstractFromPdf = true
          // No undo entry, deliberately. This is a passive background fill the
          // reviewer never asked for, triggered merely by looking at a paper —
          // pushing it onto the undo stack would mean `Ctrl+Z` after a decision
          // silently removes an abstract instead of undoing that decision. It
          // follows the editor's own background title/author fill
          // (`addPickedPdfs`), which likewise patches rows without an undo step
          // of its own. `dirty` still gets set, so the ordinary unsaved-changes
          // path persists it.
          s.dirty = true
        })
      } catch {
        // An unreadable PDF, or the fetch itself failing, just leaves the
        // abstract empty — the same outcome as never having tried.
      } finally {
        set((s) => {
          // Only if the success path above did not already clear it.
          if (s.screeningAbstractReads[paperId] === 'reading') {
            s.screeningAbstractReads[paperId] = 'none'
          }
        })
      }
    },

    adoptAllUnanimousScreening: () => {
      const project = get().project
      if (!project || project.screening === null) return 0
      let filledPapers = 0
      let coalesce = false
      for (const paper of project.papers) {
        const fieldsFilled = get().adoptUnanimousValues(paper.id, coalesce)
        if (fieldsFilled > 0) {
          filledPapers++
          coalesce = true
        }
      }
      return filledPapers
    },

    adoptAllUnanimousAnnotations: async () => {
      const project = get().project
      // Screening has its own button (`adoptAllUnanimousScreening`): its
      // schema has no repeatable node, so it needs none of the lining-up
      // below and stays synchronous.
      if (!project || project.screening !== null || project.reviewers <= 1) return
      // A second run would interleave two coalesce chains and split the batch
      // across two undo entries.
      if (get().unanimousRun?.running) return

      const schema = project.schema
      const alignable = alignableNodes(schema)
      const alignableDefs = schema.filter((d) => alignable.includes(d.name))
      const paperIds = project.papers.map((p) => p.id)

      set((s) => {
        s.unanimousRun = { done: 0, total: paperIds.length, filled: 0, skipped: 0, running: true }
      })

      // One undo press for the whole batch, the way lining a single paper up
      // already is (see `alignConsolidationNode`): `coalesce` turns true only
      // once something has actually changed, so the one entry that does get
      // pushed holds the project as it was before the first write. A keystroke
      // typed by the consolidator mid-run pushes its own entry and splits the
      // chain — the data stays correct (every write here is idempotent, so a
      // rerun repairs it), only the undo granularity degrades. Accepted rather
      // than guarded against: blocking the form for a background fill would be
      // worse than that.
      let coalesce = false
      let filled = 0
      let skipped = 0

      for (const paperId of paperIds) {
        // Closing or replacing the project clears `unanimousRun`, which is
        // what stops a run whose papers are no longer the ones on screen.
        if (!get().unanimousRun?.running) return

        // Re-read every iteration: immer swaps in a new `project` object on
        // every write, so a `paper` captured before the loop started would be
        // stale by the second iteration.
        const paper = get().project?.papers.find((p) => p.id === paperId)
        if (paper) {
          // Alignment declines to re-match a node the consolidator has
          // answered, and says so by changing nothing — which is
          // indistinguishable from "already lined up". So the question is
          // asked here instead: if any alignable node is in that state, this
          // paper's entries are in an order nothing has vouched for, and
          // reading across them at a fixed index would invent agreement
          // rather than find it.
          //
          // The paper is left alone whole rather than adopted in part: a
          // paper whose node the consolidator has answered is one they have
          // already opened, and opening it is what ran this exact fill
          // interactively. Recovering the rest would mean asking whether the
          // data happens to already sit in aligned order — a real question,
          // but one that costs a full match per blocked node to answer and
          // buys back only papers that were already filled when they were
          // opened.
          const blocked = alignableDefs.some((def) => consolidatorHasAnswered(def, paper.annotations))
          if (blocked) {
            skipped++
          } else {
            for (const nodeName of alignable) {
              if (get().alignConsolidationNode(paperId, nodeName, coalesce)) coalesce = true
            }
            if (get().adoptUnanimousValues(paperId, coalesce) > 0) {
              coalesce = true
              filled++
            }
          }
        }

        set((s) => {
          if (!s.unanimousRun) return
          s.unanimousRun.done++
          s.unanimousRun.filled = filled
          s.unanimousRun.skipped = skipped
        })
        // Matching one large paper measures in the hundreds of milliseconds
        // (see `useConsolidationAlignment`), so a hundred of them in one pass
        // would freeze the window. A paper is the smallest unit that can be
        // yielded between and still be correct: all of its nodes must be
        // lined up before any of its values are read across.
        await yieldToBrowser()
      }

      set((s) => {
        if (s.unanimousRun) s.unanimousRun.running = false
      })
    },

    dismissUnanimousRun: () => {
      set((s) => {
        s.unanimousRun = null
      })
    },

    /**
     * Stop a batch adopt-unanimous run, if one is in flight.
     *
     * Called from undo and redo. The run writes one paper per macrotask and
     * coalesces them all into the single history entry its first paper pushed,
     * so a history move landing in the middle of it leaves no coherent state:
     * the undo reverts the papers written so far, the run carries on writing
     * more *without* pushing a snapshot (coalesce skips it) and so never
     * invalidates `future`, and the redo the reviewer naturally reaches for
     * then restores the pre-undo papers while discarding everything written
     * after it. Measured on a six-paper run: no undo/redo position existed
     * that held all six.
     *
     * Stopping the run makes the undo mean what it says — revert what was
     * adopted — and the loop's own `running` check does the rest.
     */
    stopUnanimousRun: () => {
      set((s) => {
        if (s.unanimousRun?.running) {
          s.unanimousRun.running = false
          s.unanimousRun.interrupted = true
        }
      })
    },

    undo: () => {
      get().stopUnanimousRun()
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
        clearPendingMarkLink(s)
      })
    },

    redo: () => {
      get().stopUnanimousRun()
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
        clearPendingMarkLink(s)
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
  // See `MAX_UNBOUNDED_INDEX`: the push loop below materializes every instance
  // up to `index`, so an unbounded node still needs a ceiling.
  if (index >= (def.max === null ? MAX_UNBOUNDED_INDEX : def.max)) return null

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

/**
 * Drop a pending "just created this mark" offer outright — the reviewer did
 * something that isn't one of the two moves `lastCreatedMarkId` stays alive
 * through (see its own doc comment): edited a field other than the one the
 * mark turns out to belong to, added/removed an instance, touched another
 * mark, undid something, ... Called at the start of every such action, on
 * the same draft the action is about to mutate.
 *
 * A no-op whenever nothing is pending, so every caller can call it
 * unconditionally rather than checking first.
 */
function clearPendingMarkLink(s: AppState): void {
  s.lastCreatedMarkId = null
  s.lastCreatedMarkAllowedField = null
}

/**
 * Record that `canonical` is the field just edited, on the draft a field
 * edit is about to apply to — called from `setFieldValue` before it writes
 * the new value.
 *
 * The first field touched after a mark is created narrows the pending offer
 * to that field alone (case (b): highlight, type the value in, then link —
 * still auto-links). Touching a *second*, different field means the
 * reviewer has moved on to something else, so the offer is withdrawn
 * entirely rather than re-narrowed to the new field — by then it is no
 * longer "the very next thing" after making the mark. Editing the same
 * field again (typing further into it) changes nothing.
 */
function noteFieldTouchForPendingMarkLink(s: AppState, canonical: string): void {
  if (!s.lastCreatedMarkId) return
  if (s.lastCreatedMarkAllowedField === null) {
    s.lastCreatedMarkAllowedField = canonical
  } else if (s.lastCreatedMarkAllowedField !== canonical) {
    clearPendingMarkLink(s)
  }
}

/** Back to the event loop, so a progress count paints and the window stays live. */
const yieldToBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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

/**
 * How many PDF marks (highlights/notes) are linked to this field instance —
 * for the field's link badge. Returns a plain number rather than a `PdfMark[]`
 * deliberately: a selector returning a freshly-filtered array every call has
 * the same stale-reference hazard `EMPTY_MARKS` exists to avoid (see its own
 * doc comment — a fresh `[]`/array literal every call breaks
 * `useSyncExternalStore`). A number compares correctly with Zustand's default
 * `Object.is`, sidestepping the problem instead of reproducing it. The full
 * list (for the popover) is read directly from `currentPdfMarks()` where it's
 * needed instead, since that already returns a stable reference.
 */
export function useLinkedMarkCount(path: PathSeg[], name: string, index: number): number {
  const canonical = fieldPath(path, name, index)
  return useStore((s) => {
    const marks = dedupeMarkGroups(s.currentPdfMarks())
    let n = 0
    for (const m of marks) if (m.linkedFields?.some((l) => l.path === canonical)) n++
    return n
  })
}
