import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  loadProject,
  serializeProject,
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
import { consolidatorHasAnswered, consolidationMark } from '../consolidate/readiness'
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
 * Key of one field instance's "the AI wrote this" mark. Scoped by paper, and by
 * reviewer when `reviewer` is non-null — `null` (the single-reviewer default)
 * reproduces the original two-part key exactly. Uses `formatPath`'s canonical
 * form, so an LLM suggestion and a UI lookup meet on the same string.
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
 * removed: siblings after it shift down by one, so anything naming them (mark
 * links, AI marks, `paper.equal`, deferred consolidations) stays valid instead
 * of pointing at whoever inherited the old slot. Returns `null` for the
 * removed instance itself (or something inside it); an unparseable or
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
 * like `containerAt` but addressed by slot position, not array index.
 * `resolveIndex` resolves a caller's index to a slot: search `members` for a
 * reviewer's own edit; use the index directly for consolidation, since
 * `growConsolidated` never reorders it, only grows it. Returns `undefined`
 * where the path doesn't resolve, so the caller can skip the fixup rather
 * than fabricate a slot list that was never computed.
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

/** The reviewer scope for a mark key: `null` for a single-reviewer project
 *  (keeps keys byte-for-byte the old format), otherwise the current selection. */
function markReviewerScope(project: Project | null, currentReviewer: string | null): string | null {
  return project && project.reviewers > 1 ? currentReviewer : null
}

function isDeferredValueEmpty(value: FieldValue): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

const REVIEWER_KEY_PREFIX = 'slr.currentReviewer.'

/**
 * Stable per-project key for persisting the reviewer selection: the save
 * handle's path doubles as the key (see `SaveHandle`). A project with no path
 * (server mode, browser download-only) can't be told apart from another on
 * the next launch, so the selection simply isn't persisted for it. Deliberately
 * `localStorage`, per-machine — a local convenience, never written to the JSON.
 */
function reviewerStorageKey(handle: SaveHandle | null): string | null {
  return handle?.path ? `${REVIEWER_KEY_PREFIX}${handle.path}` : null
}

/** How many paper ids a remembered seat carries to recognise its project by. */
const REVIEWER_FINGERPRINT_SAMPLE = 8

/**
 * Paper ids identifying the project a seat was picked in.
 *
 * The key is the file's path, and a path is not an identity: save a different
 * project over it, or delete and recreate one there, and the old seat was
 * silently inherited — the picker never appeared and every edit landed in
 * whichever seat the *previous* project's reviewer had chosen. (The reading
 * position next door already guards this; the seat never did.)
 *
 * Sorted and capped so the value stays small, and matched by *overlap* rather
 * than equality: papers get added and removed all the time in a live review,
 * and a fingerprint that changed then would re-ask for the seat constantly —
 * which is how a guard turns into something reviewers click through. A
 * genuinely different project shares none of these ids.
 */
function reviewerFingerprint(project: Project): string[] {
  return project.papers
    .map((p) => p.id)
    .sort()
    .slice(0, REVIEWER_FINGERPRINT_SAMPLE)
}

/** The stored shape. A bare string is the pre-fingerprint format — see
 *  `loadCurrentReviewer` for why it is still honoured. */
interface StoredReviewer {
  reviewer: string
  papers: string[]
}

function parseStoredReviewer(raw: string): StoredReviewer | 'legacy' | null {
  if (!raw.startsWith('{')) return raw ? 'legacy' : null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredReviewer>
    if (typeof parsed.reviewer !== 'string' || !Array.isArray(parsed.papers)) return null
    return { reviewer: parsed.reviewer, papers: parsed.papers.filter((p) => typeof p === 'string') }
  } catch {
    return null
  }
}

/**
 * The persisted reviewer selection for this project, or null when there is
 * none, the project has no stable key, the stored value no longer fits (the
 * reviewer count shrank since it was saved), or the project at this path is
 * not the one the seat was picked in (see `reviewerFingerprint`).
 *
 * A value written before fingerprints existed is honoured rather than thrown
 * away — re-asking every existing reviewer for a seat they already picked
 * would be a worse first impression than the narrow case it protects — and
 * `loadFromText` rewrites it with a fingerprint immediately, so each project
 * upgrades itself the first time it is opened.
 */
function loadCurrentReviewer(handle: SaveHandle | null, project: Project): string | null {
  const key = reviewerStorageKey(handle)
  if (!key) return null
  const raw = safeGet(key)
  if (raw === null) return null
  const stored = parseStoredReviewer(raw)
  if (stored === null) return null

  if (stored !== 'legacy') {
    const ids = new Set(project.papers.map((p) => p.id))
    // An empty remembered list can only come from a project that had no papers
    // at all, which identifies nothing — treat it as not knowing.
    if (stored.papers.length === 0 || !stored.papers.some((id) => ids.has(id))) return null
  }
  const reviewer = stored === 'legacy' ? raw : stored.reviewer
  if (reviewer === 'consolidation') return reviewer
  const n = Number(reviewer)
  return Number.isInteger(n) && n >= 1 && n <= project.reviewers ? reviewer : null
}

function saveCurrentReviewer(
  handle: SaveHandle | null,
  reviewer: string | null,
  project: Project | null,
): void {
  const key = reviewerStorageKey(handle)
  if (!key) return
  if (reviewer === null || !project) safeRemove(key)
  else safeSet(key, JSON.stringify({ reviewer, papers: reviewerFingerprint(project) }))
}

const READING_POSITION_KEY_PREFIX = 'slr.readingPosition.'

/** Same per-machine, `localStorage`, keyed-by-path convention as
 *  `reviewerStorageKey` — a local convenience, never written to the shared JSON. */
function readingPositionKey(handle: SaveHandle | null): string | null {
  return handle?.path ? `${READING_POSITION_KEY_PREFIX}${handle.path}` : null
}

interface StoredReadingPosition {
  paperId: string
  page: number
  /** Fraction of `page`'s rendered height scrolled into (0 = top), the same
   *  resolution-independent convention as `MarkRect`. Missing (older stored
   *  values) treated as 0. */
  offsetFraction: number
}

/** The persisted reading position for this project, or null if none/malformed.
 *  Not checked against the paper list here — `loadFromText` does that. */
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

/**
 * A save failure, as something a reviewer can read.
 *
 * `ErrorPanel` renders `details` one line per entry, so a multi-line message
 * has to be split to survive — and the messages worth reading are multi-line:
 * the refusal to overwrite files that changed on disk names the files and then
 * what to do about them (see `staleSaveError`). Collapsed into a single
 * paragraph it reads as a wall of text at exactly the moment somebody needs to
 * act on it.
 */
function saveFailure(err: unknown): LoadError {
  const text = err instanceof Error ? err.message : String(err)
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const [headline, ...rest] = lines
  return { message: headline ?? 'Failed to save.', details: rest }
}

export interface LoadError {
  message: string
  details: string[]
}

/** How many corrupt file names `corruptFilesWarning` lists before it stops. */
const CORRUPT_LIST_LIMIT = 10

/**
 * Warning for annotation files that failed to parse (`OpenedProject.corruptFiles`):
 * they load as absent, so silence would let a reviewer overwrite work still on disk.
 * Files themselves are never deleted (see `writeProjectFiles` in `electron/main.ts`).
 */
function corruptFilesWarning(paths: string[]): LoadError {
  const listed = paths.slice(0, CORRUPT_LIST_LIMIT)
  const rest = paths.length - listed.length
  return {
    message:
      paths.length === 1
        ? 'One annotation file could not be read; its data is missing from this session.'
        : `${paths.length} annotation files could not be read; their data is missing from this session.`,
    details: [
      ...listed.map((p) => `annotations/${p}`),
      ...(rest > 0 ? [`…and ${rest} more`] : []),
      'They are not valid JSON — a leftover git merge conflict is the usual cause. The files are left on disk untouched; repair them (or restore them from git) and reopen the project.',
    ],
  }
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
 * Bumped only when the open project is *replaced or closed*, never for an
 * ordinary edit — lets `extractScreeningAbstract`'s background read tell if its
 * result still belongs, since immer gives `project` a new reference on every
 * edit (reference equality would look stale mid-read, discarding a good abstract).
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
  /**
   * Annotation files that would not parse when the project was opened — a
   * leftover git merge conflict is the usual cause. They load as *absent*, so
   * the reviewer they belong to reads as having done nothing, everywhere.
   *
   * Kept for the session rather than only raised once as a `loadError`: that
   * banner is dismissible, and a reviewer who clicks it away has no way left
   * to find out the project is still missing somebody's work. Paths are
   * relative to `annotations/`.
   */
  corruptFiles: string[]
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
  /** Whether the schema-info dialog is open — auto-set true by `loadFromText`
   *  when the project has a `schemaInfo` comment, else toggled manually. Session-only. */
  schemaInfoOpen: boolean
  /** A mark id `PdfViewer` should scroll to and flash — requested from the
   *  field-link popover's "jump to this mark". `PdfViewer` clears it once acted on. */
  pendingMarkJump: string | null
  /**
   * Paper/page a just-opened project's landing paper scrolls to on first render
   * (from `loadReadingPosition`), so reopening returns where the reviewer left
   * off. `PdfViewer` consumes+clears it once mounted, and drops it if the
   * reviewer navigates away before the landing PDF loads. Session-only.
   */
  initialPdfPosition: { paperId: string; page: number; offsetFraction: number } | null
  /** Canonical field path whose link popover is open, or null. Session-only, like `validationOpen`. */
  openLinkPopoverField: string | null
  /** The mark `PdfViewer` most recently created and not yet linked to a field —
   *  offered to the next field-link popover to open, auto-linking it there
   *  instead of making the reviewer find it in the list. Stays valid only
   *  through the "next thing" rules in `lastCreatedMarkAllowedField`; any other
   *  action (`clearPendingMarkLink`) or a popover consuming it clears this.
   *  Session-only, like `pendingMarkJump`. */
  lastCreatedMarkId: string | null
  /**
   * Narrows what `lastCreatedMarkId` may still be auto-linked to: `null` until
   * a field is edited (any field's popover may claim it), then set to that
   * field's path so only it may claim it — editing a *different* field
   * invalidates the pending mark rather than re-narrowing.
   */
  lastCreatedMarkAllowedField: string | null
  /**
   * Every mark id `addHighlight` has produced this session, across papers and
   * reviewers, never pruned. Lets `orderMarksForLinking`'s "pin what you just
   * made" section tell "made a minute ago" from "existed since last week" —
   * `createdAt` alone can't, since marks in a freshly opened project have old
   * timestamps too. Deliberately not cleared on project close, unlike the rest
   * of this section's fields.
   */
  sessionCreatedMarkIds: string[]
  /** A canonical field path `AnnotationPanel` should scroll to and flash —
   *  requested from Validation's "jump to this field". Cleared by
   *  `AnnotationPanel` once acted on, same one-shot shape as `pendingMarkJump`. */
  pendingFieldJump: string | null
  /** The field currently pulsing after a jump — see `pendingFieldJump`. Set when
   *  that's cleared; cleared again after the flash animation's duration. */
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
   * Bumped when a different project is loaded or the current one closed, so
   * components can reset UI state that's *about* the project (search, filters) —
   * `project` itself changes on every keystroke (immer) so isn't a usable signal.
   * Without this, PaperList's search survived a project switch.
   */
  projectGeneration: number
  /** Shown when discarding an open project's unsaved changes. */
  closePromptOpen: boolean
  /** What to do once the unsaved-changes prompt is answered — carries the
   *  action it's guarding rather than assuming "close", since opening another
   *  project (or a recent) replaces the open one just as completely. */
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
   * Fields *the app* filled and the reviewer hasn't looked at yet, keyed by
   * `aiMarkKey` — produced by an applied AI suggestion or by Consolidation
   * adopting a unanimous value (`adoptUnanimousValues`; name predates that case).
   * Lives beside the project (not inside it) so it's session-only by
   * construction: `serializeProject` can't see it. Plain record, not a Set, to
   * keep immer happy.
   */
  aiMarks: Record<string, true>
  /** Fields waiting for Consolidation to enter a value other than a reviewer's answer. */
  deferredConsolidations: Record<string, true>
  /**
   * AI-assisted annotation is off by default regardless of `config.ai` (which
   * can still *forbid* it, never enable it) — unlocked only by the hidden
   * gesture in `Toolbar.tsx`, for the running session only. Never persisted.
   */
  aiUnlocked: boolean
  /**
   * Which reviewer's work is shown/edited: `"1"`.."N", `"consolidation"`, or
   * `null` (single-reviewer projects stay `null`; multi-reviewer projects also
   * start `null` so an edit is never attributed by default). Selecting is a
   * view switch, not an edit — no undo step, no `dirty` — and persists per
   * project (see `saveCurrentReviewer`).
   */
  currentReviewer: string | null
  /** The field a Consolidation-mode "compare" click is showing, or null when
   *  the compare popup is closed. Session-only, like `validationOpen`. */
  consolidationTarget: { path: PathSeg[]; name: string; index: number } | null
  /**
   * The paper whose reviewers have changed since Consolidation last ran on it,
   * while the consolidated tree already holds answers — so re-running the
   * automatic steps would write over work the consolidator has done. Holds the
   * paper id while the prompt asking what to do is open; null otherwise.
   * Session-only: the question is only worth asking with the seat open, and
   * `consolidationSync` on the paper is what remembers the answer.
   */
  consolidationUpdatePrompt: string | null
  /**
   * The paper the consolidator answered that prompt with "update" for.
   * Session-only, and cleared as soon as the run it authorises has recorded
   * its new `consolidationSync` — it exists only to let the scheduler's effect
   * see that it may now proceed.
   */
  consolidationUpdateApproved: string | null
  /** Which decisions the screening paper list shows. Session-only, like the search box's mode. */
  screeningFilter: ScreeningStatus | 'all'
  /** Which annotation state the paper list shows and its "finished: 5/100"
   *  counter reports. Session-only — a filter, not a property worth saving. */
  annotationFilter: AnnotationFilter
  /** Screening reads title + abstract by default; the PDF is the escalation path. Session-only. */
  screeningShowPdf: boolean
  /** Whether the screening progress/PRISMA summary modal is open. Session-only. */
  screeningSummaryOpen: boolean
  /**
   * Per paper id, what `extractScreeningAbstract` has done this session:
   * `'reading'` while in flight, `'none'` once a read found nothing (stops a
   * PDF with no recognisable abstract from being re-fetched on every reselect).
   * A successful read leaves no entry — `paper.abstract` itself is the guard,
   * so an undo that removes the abstract lets re-selecting extract again
   * rather than permanently losing it. Session-only.
   */
  screeningAbstractReads: Record<string, 'reading' | 'none'>

  openProject: () => Promise<void>
  openRecent: (id: string) => Promise<void>
  /** Open another project, prompting to save first if dirty. User-reachable
   *  entry points must go through these, not `openProject`/`openRecent` directly —
   *  replacing the open project discards unsaved work just as closing does. */
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
  /** Re-reads the open project from disk after a git commit/discard rewrote the
   *  working file (see `gitStore.ts`'s `runCommit`/`runDiscard`). Unlike
   *  `loadFromText`, view state (selected paper, filters) is left alone — only
   *  project data refreshes. Undo/redo history is cleared, since old snapshots
   *  would let Ctrl+Z resurrect what the resync just discarded. */
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
  /** Re-raise the "some annotation files could not be read" warning — see
   *  `corruptFiles`. */
  showCorruptFiles: () => void
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
   * Persists `page` as `paperId`'s reading position (see `saveReadingPosition`).
   * Takes `paperId` explicitly rather than reading `currentPaperId`: the call is
   * debounced, and by the time it fires the reviewer may have switched papers.
   * No-op with no stable save location, same as `saveCurrentReviewer`.
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
  /** Tick/untick "annotation finished" for the current paper/seat (see
   *  `Paper.finished`). Pushes no history entry of its own — it's a declaration,
   *  not an edit — but still rides along inside project undo/redo snapshots, so
   *  undoing the completing edit takes the declaration back with it. */
  setAnnotationFinished: (finished: boolean) => void
  undo: () => void
  redo: () => void

  /** Every mark on the current paper's PDF for whoever is reviewing — see
   *  `currentMarks`. Empty outside a paper or before a seat is picked. */
  currentPdfMarks: () => PdfMark[]
  /** Highlights `page`/`rects` in the given color (default first of
   *  `MARK_COLORS`); `kind: 'note'` instead pins a sticky note at `rects[0]`'s
   *  point. Returns the new mark id so the caller can open its comment popover.
   *  Not part of the annotation undo stack — see `pdfMarks.ts`'s own doc comment. */
  addHighlight: (
    page: number,
    rects: MarkRect[],
    color?: string,
    kind?: PdfMark['kind'],
    text?: string,
    /** Set only for one page-fragment of a highlight spanning a page boundary —
     *  fragments sharing a `groupId` are kept in sync (comment/color/links). */
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
   * Matches reviewers' repeated entries under one top-level node so position
   * means the same entry for all of them, growing the consolidated tree to one
   * entry per match. Returns whether anything moved. `coalesce` folds this node
   * into an earlier node's undo entry from the same run (one undo press, not
   * one per node) — driven by `useConsolidationAlignment`, a node at a time.
   */
  alignConsolidationNode: (paperId: string, nodeName: string, coalesce: boolean) => boolean
  /**
   * Fills consolidated fields still unanswered with the value every reviewer
   * gave (marked like an AI fill). Returns how many. Must run after
   * `alignConsolidationNode` for the whole paper — it reads every reviewer at
   * the same index, which only means anything once entries are aligned.
   */
  adoptUnanimousValues: (paperId: string, coalesce: boolean) => number
  /**
   * Record that Consolidation's automatic steps have now run against the
   * reviewers' current answers, so re-opening the seat leaves the paper alone
   * until a reviewer actually changes something. No undo entry: it describes
   * when the run happened, not what it wrote.
   */
  markConsolidationSynced: (paperId: string) => void
  /** Ask whether to fold changed reviewer answers into an already-answered
   *  consolidated tree. */
  openConsolidationUpdatePrompt: (paperId: string) => void
  /** Answer that prompt: `true` re-runs the automatic steps, `false` keeps the
   *  consolidated tree as it is and stops asking until reviewers change again. */
  resolveConsolidationUpdate: (update: boolean) => void
  /** Toggle "the reviewers' answers at this field mean the same thing". */
  toggleFieldEquality: (paperId: string, canonical: string) => void

  /**
   * Record/clear the screening decision for the active seat, optionally writing
   * the exclusion reason in the same undo step (used by the `1`-`9` shortcuts —
   * see `useKeybindings.ts`). Changing away from `Exclude` clears the reason in
   * the same mutation, since a reason without an exclusion was never chosen.
   * Advances to the next undecided paper only when the decision went from
   * undecided to decided, so re-deciding a paper never jumps away from it.
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
   * `selectPaper`/`loadFromText` so screening never needs the PDF opened by
   * hand. Never awaited — a slow/failed read just leaves the abstract empty.
   * Marks what it writes `abstractFromPdf`, so it's shown as the guess it is.
   */
  extractScreeningAbstract: (paperId: string) => Promise<void>
  /**
   * Adopt every paper's unanimous screening decision into the consolidated
   * tree, in one undo step. Returns how many papers were filled.
   *
   * Screening-only as a correctness constraint, not just scope:
   * `adoptUnanimousValues` reads every reviewer at a fixed index, which is only
   * meaningful once entries are aligned — a screening schema has no repeatable
   * node to align, so every paper is safe to read at once, unlike an ordinary
   * schema (hence the per-paper scheduler, `useConsolidationAlignment`).
   */
  adoptAllUnanimousScreening: () => number
  /**
   * Same idea as `adoptAllUnanimousScreening`, for an ordinary (non-screening)
   * schema: align every paper's reviewers, then adopt their unanimous answers,
   * across the whole project. Unlike screening, this schema can have
   * repeatable nodes, so each paper must be aligned right before it's read —
   * why the two cases can't share one driver.
   *
   * Async and yields between papers (see `UnanimousRun`): matching a hundred
   * papers in one blocking pass would freeze the window. Progress is
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
  /** True when undo/redo stopped the run part-way, so the summary can say the
   *  totals describe what was adopted before it stopped, not the whole project. */
  interrupted?: boolean
}

/**
 * Route to the tree the app should read/write right now for `paper`:
 * single-reviewer or Consolidation → `paper.annotations`; a numbered reviewer
 * → `paper.reviews[N]`; multi-reviewer with nobody selected → `null` (callers
 * must treat that as "nothing to read/write", never fall back to consolidated).
 *
 * `create: true` (only safe inside an immer `set()` producer) lazily
 * initialises and normalizes a numbered reviewer's missing tree and returns
 * the live reference so writes persist; `create: false` (default, safe from a
 * read-only selector) returns a fresh empty schema-shaped tree without
 * mutating anything.
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
 * PDF-marks counterpart to `currentTree`, same routing. Unlike `currentTree`,
 * there's no schema skeleton to normalize into — a reviewer with no marks yet
 * gets an empty array, so `create` only initializes that key on first mark.
 */
/** Stable empty-array identity for "no marks yet" — a fresh `[]` literal from
 *  a Zustand selector makes every snapshot look like a change, sending
 *  `useSyncExternalStore` into an infinite re-render loop. */
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
 * `currentTree`'s counterpart for the "finished" checkbox, same seat routing,
 * `null` when nobody has picked a seat. Read-only — no `create` variant,
 * since an absent key already means `false`.
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
 * Which paper a project opens on: the first one this seat has *not* finished
 * (its dot not green, including `flagged`), not simply the first in the list —
 * so reopening a review in progress lands on unfinished work, not settled work
 * already signed off. Falls back to the first paper once everything is
 * finished, or wherever completeness doesn't apply (screening, or a
 * multi-reviewer project with no seat picked). Includes the Consolidation
 * seat, which has its own sign-off (`completenessApplies`).
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
    corruptFiles: [],
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
    consolidationUpdatePrompt: null,
    consolidationUpdateApproved: null,
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
          // After `loadFromText`, which resets both on success.
          s.corruptFiles = opened.corruptFiles ?? []
          if (!s.loadError && s.corruptFiles.length > 0) {
            s.loadError = corruptFilesWarning(s.corruptFiles)
          }
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
        // Fire-and-forget (startup, after an editor save) — must not surface
        // as an unhandled rejection; the list simply keeps what it had.
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
        // Save failed/cancelled — keep the project open and drop the pending action.
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
      // `openProject`/`openRecent` replace the project wholesale
      // (`loadFromText` resets every per-project field) — nothing to close first.
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
        s.corruptFiles = []
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
        s.consolidationUpdatePrompt = null
        s.consolidationUpdateApproved = null
        s.screeningFilter = 'all'
        s.annotationFilter = 'all'
        s.screeningShowPdf = false
        s.screeningSummaryOpen = false
        s.screeningAbstractReads = {}
        // Refilled by whichever open path called this, once it knows (see
        // `corruptFiles`); a project loaded from text alone has none.
        s.corruptFiles = []
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
          s.corruptFiles = opened.corruptFiles ?? []
          if (!s.loadError && s.corruptFiles.length > 0) {
            s.loadError = corruptFilesWarning(s.corruptFiles)
          }
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
        // Seat must be resolved before the landing paper, since "finished" is
        // per-seat. Computed once here so this and the `set` below can't disagree.
        const reviewer = project.reviewers > 1 ? loadCurrentReviewer(handle, project) : null
        // Rewrite in the current format — which upgrades a value written
        // before fingerprints existed, and drops one this project did not
        // match so it cannot linger and be inherited again later.
        if (project.reviewers > 1) saveCurrentReviewer(handle, reviewer, project)
        // A remembered reading position wins over "first unfinished paper" —
        // that heuristic is only for when there's nothing better to go on.
        // Ignored if the paper no longer exists (deleted, or a different
        // project reusing the same file path).
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
          // Opened once per project load so a reviewer sees it before annotating.
          // Reset here (unlike `exportPdfOpen`) so switching projects never
          // leaves a stale dialog open or skips a schema comment the new file has.
          s.schemaInfoOpen = !!project.schemaInfo
          s.agreementReturnToOverview = false
          s.consolidationOverviewOpen = false
          s.disagreementsOpen = false
          s.disagreementsReturnToOverview = false
          s.returnToDisagreements = false
          // Also the run's bail-out — see `closeProject`.
          s.unanimousRun = null
          s.consolidationTarget = null
          s.consolidationUpdatePrompt = null
          s.consolidationUpdateApproved = null
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
          s.loadError = saveFailure(err)
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
        saveCurrentReviewer(handle, get().currentReviewer, get().project)
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
          s.loadError = saveFailure(err)
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

    showCorruptFiles: () => {
      const paths = get().corruptFiles
      if (paths.length === 0) return
      set((s) => {
        s.loadError = corruptFilesWarning(paths)
      })
    },

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

          // `paper.alignment` also records array indices per slot; the splice
          // above shifted survivors' indices, so left unfixed every slot at or
          // above the removed one still points at the old entry — misattributing
          // a later edit, or (for consolidation) letting "adopt this answer"
          // overwrite the wrong finding. Single-reviewer projects never
          // populate `alignment` (see its own doc comment), so nothing to fix.
          if (s.project!.reviewers > 1 && s.currentReviewer !== null) {
            if (s.currentReviewer === 'consolidation') {
              // Consolidated array is only ever grown in slot order
              // (`growConsolidated`), never reordered, so the removed index
              // *is* the slot position — drop it to track the shrunk array.
              const slots = alignmentSlotsAt(paper.alignment, path, name, (_slots, seg) => seg.index)
              if (slots && index >= 0 && index < slots.length) slots.splice(index, 1)
            } else {
              // `members[reviewer]` is this reviewer's own array index: drop the
              // entry naming the removed index, decrement every one above it.
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
      // No declaration to make when the project derives "done" from the data
      // (`config.finishCheckbox: false`) — guards the action itself against a
      // stale click, not just the panel hiding the checkbox.
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
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      // Its own undo step, like every mark mutation below — without it, Ctrl+Z
      // right after drawing a highlight would undo an earlier edit instead.
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
      // keystrokes into one undo step. Keying `lastFieldKey` distinctly
      // (`mark-comment:id`) means any other coalescable edit already breaks
      // the run, same as `setFieldValue`'s own coalescing.
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

    // Also how the field-link popover's auto-link offer (`lastCreatedMarkId`)
    // is fulfilled — `clearPendingMarkLink` below consuming it is the "offered
    // once" behavior.
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
      // Consolidation reconciles what the reviewers said; a model's answer isn't
      // one of the things being reconciled, and this tree is the one that ships.
      // No AI button here, but the dialog could be opened as a reviewer and the
      // seat switched after — refuse rather than trust the UI as the only guard.
      if (prev.currentReviewer === 'consolidation') {
        return { filled: 0, skipped: suggestions.length }
      }
      // Screening decides the review's corpus, so a model's include/exclude
      // pass is refused here too, for the same reason as Consolidation above.
      if (prev.project.screening !== null) {
        return { filled: 0, skipped: suggestions.length }
      }
      const schema = prev.project.schema
      // Check against the paper/seat the model was *asked about*, not whichever
      // is selected now — the dialog and seat picker stay usable mid-call, so
      // they can differ. Refuse on mismatch rather than retarget: writing to
      // the run's paper while the reviewer looks elsewhere would be correct
      // attribution but invisible work, and fabricates an `aiUsage` record for
      // a paper nobody read. Refusing keeps the reply on screen to apply later.
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

      // Decide what to write before touching anything, so a no-op run leaves no
      // empty undo entry. Drops a suggestion whose path no longer resolves, or
      // whose field has since been answered — never overwrites the reviewer.
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
        // Resolved by id, against the run's seat — re-deriving from "what is
        // current" here would reopen the gap the check above exists to close.
        const paper = s.project?.papers.find((p) => p.id === paperId)
        if (!paper) return
        const writeTree = currentTree(s.project!, target.reviewer, paper, true)
        if (!writeTree) return
        pushPast(s, snap)
        for (const { at, value } of accepted) {
          // The model may address a not-yet-existing entry of a repeatable node
          // (how it records a further Finding) — create instances along the path.
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
        // A disclosure record, not a UI hint — added only when something actually
        // changed, and meant to reach the saved file, unlike the mark above.
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
      // A view switch, not an edit: no undo step, no dirty flag.
      //
      // Breaks undo-coalescing across the seat change, like `selectPaper` does:
      // the coalescing key is field-path only (no seat), so without this an
      // edit to the same field under the new reviewer would glue onto the
      // previous reviewer's undo step, and one Undo would wipe both answers.
      lastFieldKey = null
      saveCurrentReviewer(get().saveHandle, reviewer, get().project)
      set((s) => {
        s.currentReviewer = reviewer
        // Marks are per-seat too (`reviewMarks`) — invisible under another
        // reviewer, so nothing for a later popover to auto-link.
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
        // Settling a field this way doesn't mean the reviewers agreed — only
        // `toggleFieldEquality` may set `equal`, or agreement stats would be inflated.
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

      // Once the consolidator has committed an answer under this node, entry N
      // means something specific to them, so re-matching could quietly move a
      // different entry into slot N. That freeze must not lock out a reviewer
      // with no assignment yet (added after the freeze, or hadn't started this
      // paper) — so a frozen node still runs `widenAlignment` below instead of
      // returning outright: it only adds a reviewer absent from every slot's
      // `members`, never moves one already there.
      const frozen = consolidatorHasAnswered(def, paper.annotations)

      // Only numbered reviewers who've actually written something vote — the
      // consolidated tree being built from them can't match against itself,
      // and every reviewer has a tree since load (`normalizeReviews`), so
      // presence alone can't distinguish "has an opinion" from "hasn't started".
      const reviews: Record<string, AnnotationValueTree> = {}
      for (let i = 1; i <= project.reviewers; i++) {
        const tree = paper.reviews[String(i)]
        if (tree && hasAnnotations(project.schema, tree)) reviews[String(i)] = tree
      }
      if (Object.keys(reviews).length < 2) return false

      // Computed before opening a draft: this is the expensive part, not worth
      // proxying through an immer draft.
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

        // Nothing here touches `draft.reviews` — recording who matched whom
        // doesn't rewrite reviewers' own entries into slot order, so their
        // canonical paths (marks, AI marks) still name the index they always did.
        const mappingChanged = !deepEqualJson(draft.alignment[nodeName], nodeStored)
        const grew = growConsolidated(s.project!.schema, treeForGrow, draft.annotations)
        changed = mappingChanged || grew
        if (!changed) return

        if (mappingChanged) draft.alignment[nodeName] = nodeStored

        // One undo step for the whole paper, not one per node — `coalesce` is
        // the scheduler saying a run's first node already took the snapshot.
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
      // per field via `isUnanswered`, so an all-empty tree and an absent one
      // read the same either way.
      const reviews: Record<string, AnnotationValueTree | undefined> = {}
      for (let i = 1; i <= project.reviewers; i++) reviews[String(i)] = paper.reviews[String(i)]

      // Through the mapping, not raw: `unanimousFills` reads every reviewer at
      // one index, which only means "the same entry" in slot space.
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
          // Same mark an AI fill gets — the value is the app's doing until the
          // consolidator looks at it. Scoped to Consolidation, the only seat
          // that can produce these.
          s.aiMarks[aiMarkKey(paperId, fill.canonical, 'consolidation')] = true
        }
        s.dirty = true
      })
      lastFieldKey = null
      return fills.length
    },

    markConsolidationSynced: (paperId) => {
      const project = get().project
      if (!project) return
      const paper = project.papers.find((p) => p.id === paperId)
      if (!paper) return
      const mark = consolidationMark(project.schema, paper)
      if (paper.consolidationSync === mark && get().consolidationUpdateApproved !== paperId) return
      set((s) => {
        const draft = s.project!.papers.find((p) => p.id === paperId)
        if (!draft) return
        if (s.consolidationUpdateApproved === paperId) s.consolidationUpdateApproved = null
        if (draft.consolidationSync === mark) return
        // No `pushPast`: this is a record of *when* the automatic steps last
        // ran, not one of their writes. Folding it into their undo entry would
        // be wrong too — undoing the writes should also undo the claim that
        // they happened, and immer's snapshot of the whole project already
        // does that for free.
        draft.consolidationSync = mark
        s.dirty = true
      })
    },

    openConsolidationUpdatePrompt: (paperId) =>
      set((s) => {
        s.consolidationUpdatePrompt = paperId
      }),

    resolveConsolidationUpdate: (update) => {
      const paperId = get().consolidationUpdatePrompt
      if (!paperId) return
      set((s) => {
        s.consolidationUpdatePrompt = null
        // Approving lets the scheduler's effect run; declining records the
        // reviewers' current answers as seen, which is what stops the same
        // question being asked on every visit.
        s.consolidationUpdateApproved = update ? paperId : null
      })
      if (!update) get().markConsolidationSynced(paperId)
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
      // Read before mutating: whether to auto-advance below depends on the state
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
        // Clear the reason in the same mutation (a reason without an exclusion
        // was never chosen). Write both here for the `1`-`9` shortcuts too — a
        // second call would land on whatever paper auto-advance just moved to.
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
        // runtimes. See aiStore.ts's `run()` for the identical pattern.
        const src = await getPlatform().getPdfSource(paper.pdf, get().saveHandle ?? { kind: 'download' })
        let bytes: ArrayBuffer
        try {
          bytes = await (await fetch(src.url)).arrayBuffer()
        } finally {
          src.revoke?.()
        }
        const meta = await extractPdfMeta(bytes)
        if (!meta.abstract) return

        // Staleness is only about the project being gone, not about selection
        // or edits since — this abstract belongs to `paperId` regardless, so a
        // late result is still written. See `projectGeneration`.
        if (projectGeneration !== generation) return
        set((s) => {
          // Found an abstract, so must never end up marked `'none'` (which
          // means "nothing to find" and would block a later retry).
          delete s.screeningAbstractReads[paperId]
          const target = s.project?.papers.find((p) => p.id === paperId)
          // Re-checked: a hand edit may have supplied an abstract meanwhile.
          if (!target || target.abstract) return
          target.abstract = meta.abstract
          target.abstractFromPdf = true
          // No undo entry, deliberately — a passive background fill; pushing it
          // would mean Ctrl+Z after a decision silently removes the abstract
          // instead of undoing that decision. `dirty` still persists it normally.
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
      // Screening has its own button (`adoptAllUnanimousScreening`) and stays
      // synchronous — its schema has no repeatable node to line up.
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

      // One undo press for the whole batch, like `alignConsolidationNode`:
      // `coalesce` turns true only once something changed, so the one pushed
      // entry holds the pre-run project. A keystroke mid-run splits the chain
      // (accepted — every write here is idempotent, so a rerun repairs it;
      // blocking the form would be worse).
      let coalesce = false
      let filled = 0
      let skipped = 0

      for (const paperId of paperIds) {
        // Closing or replacing the project clears `unanimousRun`, which is
        // what stops a run whose papers are no longer the ones on screen.
        if (!get().unanimousRun?.running) return

        // Re-read every iteration: immer swaps in a new `project` on every
        // write, so a `paper` captured before the loop would go stale.
        const paper = get().project?.papers.find((p) => p.id === paperId)
        if (paper) {
          // Alignment declines to re-match a node the consolidator has answered,
          // changing nothing — indistinguishable from "already lined up". So
          // checked here instead: if any alignable node is in that state, this
          // paper's order is unvouched, and reading across it would invent
          // agreement. Skipped whole rather than partially adopted — recovering
          // the rest would cost a full match per blocked node for little gain.
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
        // Yields per paper, the smallest unit that's still correct — all of a
        // paper's nodes must be lined up before its values are read across.
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
     * Stop a batch adopt-unanimous run, if one is in flight. Called from undo
     * and redo: the run writes one paper per macrotask, coalesced into one
     * history entry, so a history move mid-run leaves no coherent state — the
     * run would keep writing past the undo without pushing a new snapshot,
     * and a redo would restore pre-undo papers while discarding later writes.
     * Stopping makes undo mean what it says; the loop's `running` check does the rest.
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
        // Undoing an AI run may empty exactly the fields a mark points at, and
        // marks aren't part of history — simplest honest answer is to drop them all.
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

  // The JSON is hand-editable, so this key may not hold a list at all — replace
  // rather than crash; a malformed node has no answer worth preserving.
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
 * Drop a pending "just created this mark" offer — called whenever the
 * reviewer does something other than the two moves `lastCreatedMarkId` stays
 * alive through (see its own doc comment). No-op when nothing is pending, so
 * every caller can call it unconditionally.
 */
function clearPendingMarkLink(s: AppState): void {
  s.lastCreatedMarkId = null
  s.lastCreatedMarkAllowedField = null
}

/**
 * Record that `canonical` is the field just edited, called from `setFieldValue`
 * before it writes. The first field touched after a mark is created narrows
 * the pending offer to that field alone; touching a *different* field withdraws
 * the offer entirely rather than re-narrowing, since it's no longer "the very
 * next thing" after making the mark.
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
 * How many PDF marks are linked to this field instance, for the link badge.
 * Returns a plain number, not `PdfMark[]`: a freshly-filtered array every call
 * has the same stale-reference hazard `EMPTY_MARKS` avoids, breaking
 * `useSyncExternalStore`. A number compares correctly with `Object.is` instead.
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
