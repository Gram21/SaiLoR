import { z } from 'zod'
import {
  compactVisibleIf,
  projectSchema,
  resolveSchema,
  SchemaError,
  type ResolvedDef,
  type ScreeningConfig,
} from './schema'
import {
  hasAnnotations,
  normalizeTree,
  pruneTree,
  treeHoldsOrphans,
  type AnnotationValueTree,
} from './annotations'
import { screeningSchemaDefs } from '../screening/schema'
import { t } from '../i18n'
import { parseYear } from './year'
import { parseMarks, parseReviewMarks, type PdfMark } from './pdfMarks'
import { parseAlignment, type StoredAlignment } from './alignment'
import { annotationsDirProblem } from './annotationsDir'
import { parseStrictConfig, strictConfigJson, type StrictConfig } from './strict'
import { parseMetadataEditMode, parseReviewMetadata, type MetadataEditMode, type SeatMetadata } from './metadata'
import { parsePdfFolder } from './pdfFolder'
import {
  moveInMarks,
  moveInTree,
  parseSchemaHistory,
  parseSchemaVersion,
  pendingMoves,
  type SchemaHistoryEntry,
  type SchemaMove,
} from './schemaVersion'

/**
 * One AI-assisted-annotation pass applied to a paper. A permanent disclosure
 * record (unlike the session-only `aiMarks` in the store) meant to survive
 * into the saved file so any reviewer can see AI was used. Append-only.
 */
export interface AiUsageRecord {
  /** The provider id at the time of use, e.g. "openai" — not the display label. */
  provider: string
  /** The model name exactly as configured, e.g. "gpt-5.5". */
  model: string
  /** ISO 8601 timestamp of the Apply click. */
  appliedAt: string
  // [impl->req~llm-550~1]
  // [impl->req~llm-630~1]
  /** "prompt" for a single suggest-and-apply pass, "agent" for the
   *  tool-using agent with a judge review loop, "classify" for a System One
   *  decision-model pass, "screening" for an include/exclude proposal pass.
   *  Absent for a record predating this distinction. */
  mode?: 'prompt' | 'agent' | 'classify' | 'screening'
  /** The judge model that reviewed the agent's answers, agent mode only. */
  judge?: { provider: string; model: string }
  /** How many agent rounds ran. Agent mode only. */
  rounds?: number
  /** The judge's verdicts on the values that were actually applied — not
   *  every value the agent proposed. */
  verdicts?: { accept: number; revise: number; reject: number }
  /** How many example papers were shown as few-shot context. */
  fewShot?: number
  // [impl->req~llm-240~1]
  // [impl->req~llm-580~1]
  /** How many of the applied rows the reviewer edited before applying, out of
   *  however many this record covers. The field still counts as AI-assisted
   *  regardless — editing a proposal doesn't erase that it started as one. */
  edited?: number
  // [impl->req~llm-660~1]
  /** How many already-answered fields the AI re-check replaced (each was an
   *  explicit reviewer tick — see REQ-LLM-660). */
  rechecked?: number
  // [impl->req~llm-670~1]
  /** Provider web searches the agent ran, when web search was on. */
  webSearches?: number
  // [impl->req~llm-770~1]
  /** How many applied values carried a quote the offline check could not
   *  confirm: not found in the paper text, or not on the page named. */
  unverifiedQuotes?: number
  // [impl->req~llm-780~1]
  /** The versions of the prompt templates that produced the values, joined
   *  by "+", e.g. "agent-1+judge-1". Absent for a record predating versions. */
  promptVersion?: string
  /** The seat the values were written into ("1".."N" or "consolidation"). */
  reviewer?: string
}

/** ISO times of the locking save and of the last reopen by the Manager. */
export interface SeatLock {
  finishedAt?: string
  reopenedAt?: string
}

// [impl->req~dat-240~1]
export interface Paper {
  id: string
  title: string
  authors: string[]
  doi?: string
  /**
   * `undefined` means "unknown", including "in press"/"to appear" — those are a
   * publication *status*, not a year, so they belong in `venue` free text
   * instead (e.g. `"To appear in ICSE 2026"`), not encoded into this number.
   */
  year?: number
  /**
   * One free-text field, not separate journal/proceedings/publisher fields: no
   * source format reliably distinguishes them, and a screener just needs to
   * read "TSE" or "ICSE 2024".
   */
  venue?: string
  /** Screening is normally decided on title + abstract, so this is the
   *  reading surface when there is no PDF. */
  abstract?: string
  /**
   * True when `abstract` came from the PDF-text heuristic (`extractPdfMeta` in
   * `pdfMeta.ts`) rather than being typed or imported. A durable disclosure
   * like `aiUsage`, so every later reviewer sees "unverified". Cleared once a
   * human or reference-file import provides a real abstract (`fillFromRef` in
   * `editorStore.ts`).
   */
  abstractFromPdf?: boolean
  pdf: string
  /** The single/consolidated result — what `validateProject`, `hasAnnotations`,
   *  and export read, and what a single-reviewer project uses exclusively. */
  annotations: AnnotationValueTree
  /** Each independent reviewer's own annotations, keyed "1".."N". Absent/empty
   *  in a single-reviewer project — `annotations` alone carries the data. */
  reviews: Record<string, AnnotationValueTree>
  /** AI-assisted annotation passes, oldest first. Empty when AI has never
   *  been used on this paper. */
  aiUsage: AiUsageRecord[]
  /**
   * Canonical field paths where the consolidator has declared the reviewers'
   * differing answers to mean the same thing (e.g. "RCT" vs. "randomized
   * controlled trial"). One boolean per field, not per reviewer pair — exact
   * for two reviewers, but with three+ it can't express "these two agree but
   * that one doesn't"; see `disagreements.ts`.
   */
  equal: string[]
  /** Which of each reviewer's repeated entries are the same entry, per
   *  Consolidation's matcher. Empty until the Consolidation seat runs; see
   *  `model/alignment.ts` for why this is recorded rather than derived. */
  alignment: StoredAlignment
  /**
   * `reviewsFingerprint` of the reviews as of the last time Consolidation's
   * automatic steps ran on this paper. Undefined means they never have, or
   * the paper predates this field.
   *
   * Persisted so re-opening the project does not re-run them: those steps are
   * only safe to repeat while the reviewers' work is unchanged, and one of
   * them (adopting unanimous answers) would otherwise put back a value the
   * consolidator deliberately cleared. See `consolidate/readiness.ts`.
   */
  consolidationSync?: string
  /** PDF highlights/comments for the single/consolidated tree. Same
   *  single-tree-vs-per-reviewer split as `annotations`/`reviews`. */
  marks: PdfMark[]
  /** Each independent reviewer's own marks, keyed "1".."N" like `reviews`.
   *  Absent/empty in a single-reviewer project. */
  reviewMarks: Record<string, PdfMark[]>
  /**
   * The "I am done with this paper" checkbox — turns the paper list's dot
   * green (see `paperIsFinished` in `PaperList.tsx`). Deliberately *not*
   * derived from the data: a full tree just means the form is full, not that
   * a human judged the extraction correct. Not re-derived on load either, so
   * a later edit emptying a field leaves this flag standing (the dot still
   * requires both) — nothing silently un-declares what was declared.
   */
  finished: boolean
  /** Each numbered reviewer's own finished flag, keyed "1".."N" like `reviews`.
   *  Absent/empty in a single-reviewer project. */
  reviewsFinished: Record<string, boolean>
  /** Each numbered seat's metadata overrides and ignored proposals, keyed
   *  "1".."N". Absent when no seat has any. See `model/metadata.ts`. */
  reviewMetadata?: Record<string, SeatMetadata>
  /** Each numbered seat's strict-mode edit lock, keyed "1".."N". Absent when no seat has one. */
  reviewsLock?: Record<string, SeatLock>
  /** Any additional fields present in the source file are preserved on save. */
  extra: Record<string, unknown>
  /** Files of this paper written under a schema version the project's
   *  history does not know, and so left as they were: `consolidated`,
   *  `review-<n>`, `marks-consolidated`, `marks-<n>`. Absent when none. */
  unknownSchemaFiles?: string[]
}

/**
 * The review's own protocol (research questions, search, criteria), recorded
 * *inside* the project file so it travels with the data it produced. A
 * first-class field, not a `config` key: `config` is rebuilt from scratch on
 * every save (see `serializeProject`), so anything hand-added under it would
 * be silently dropped on the next save.
 */
export interface ProjectProtocol {
  /** The review's research questions, one per entry. */
  researchQuestions?: string[]
  /** The queries run against the databases below — often one per database, or
   *  per facet of the query. */
  searchStrings?: string[]
  /** The sources searched, e.g. "Scopus", "IEEE Xplore", "ACM DL". */
  databases?: string[]
  /** When the search was run. Free text, not an ISO instant: a search is
   *  usually a range or a month ("2024-03", "March–April 2024"), and pinning
   *  it to one timestamp would misrepresent that. */
  searchDate?: string
  /** Inclusion/exclusion criteria, and any other protocol notes, as free text. */
  notes?: string
}

/**
 * Where a project's papers came from when built by importing from another
 * project, so a shared git-committed file can answer "where did this come
 * from" (for a PRISMA flow diagram) without either source file reachable.
 */
export interface ProjectProvenance {
  /** Only one origin exists today; a discriminant keeps a second one additive. */
  kind: 'screening-import'
  source: {
    /** The source project's `title`, when it had one. */
    title?: string
    /** File name only, never a path — these files are committed to git and
     *  shared, and a path leaks the author's filesystem layout. */
    file: string
  }
  /** ISO 8601, the moment of import. */
  importedAt: string
  /** The source's census at import time. A snapshot, not derivable later since
   *  papers get added/removed afterward. `carried` is what PRISMA's flow
   *  diagram wants. */
  counts: { included: number; undecided: number; excluded: number; carried: number }
}

// [impl->req~dat-285~1]
export interface Project {
  version: number
  /** Display name for the review; empty when the file doesn't set one. */
  title?: string
  /** Set when this project's papers were imported from another project; null
   *  otherwise. Required, not optional, so `mergeProjects` can't silently
   *  drop it via an unhandled `undefined`. */
  provenance: ProjectProvenance | null
  /** The review's authored protocol, or null when the file records none.
   *  Required for the same reason `provenance` is. */
  protocol: ProjectProtocol | null
  /** Free-text "about this schema" note shown via an info button in the
   *  annotation panel, auto-opened once on load. Required for the same reason
   *  `protocol` is. */
  schemaInfo: string | null
  schema: ResolvedDef[]
  /** Id of this schema version (see `model/schemaVersion.ts`); null for a
   *  project whose schema has not been edited since versions existed. */
  schemaVersion: string | null
  /** Every schema version so far, oldest first, with its renames and moves. */
  schemaHistory: SchemaHistoryEntry[]
  /** The project's annotations folder, one folder directly inside the project
   *  file's directory; null means the default `annotations`. See
   *  `model/annotationsDir.ts`. */
  annotationsDir: string | null
  /** A folder name the file gave that is not allowed, and so was ignored in
   *  favour of the default. Not written back. */
  refusedAnnotationsDir?: string
  /** Whether AI-assisted annotation is available. Defaults to false; opt in
   *  with `config.ai: true`. */
  aiEnabled: boolean
  /**
   * Whether a paper must be signed off by hand ("Annotation finished"
   * checkbox). Defaults to true; opt out with `config.finishCheckbox: false`.
   *
   * With it **off**, a paper counts as finished exactly when its schema is
   * fulfilled, so `Paper.finished`/`reviewsFinished` are never read and the
   * "finished but a required field is empty" state is unreachable.
   *
   * A *project* setting, not per-reviewer: whether "done" means "a human said
   * so" or "the form is full" decides what every green dot means, so two
   * reviewers can't disagree about that within one review.
   *
   * Ticks recorded while on are kept untouched, so turning it back on
   * restores them rather than starting over.
   */
  finishCheckbox: boolean
  /**
   * Number of independent reviewers. 1 (default) means single-reviewer: one
   * `annotations` tree per paper. More than 1 means reviewers 1..N annotate
   * independently into `Paper.reviews[N]`, reconciled by a Consolidation role
   * into `Paper.annotations`.
   */
  reviewers: number
  /**
   * Whether one reviewer seat is dedicated to the AI, so its answers are
   * compared against the human reviewers' like any other seat. Defaults to
   * false; opt in with `config.aiSeat: true`. Only *effective* when
   * `aiEnabled && reviewers >= 2` — see `aiSeatId`. Stored as
   * authored even when ineffective (e.g. AI turned off, or reviewers dropped
   * below 2), so re-enabling either restores it rather than losing the choice.
   */
  aiSeat: boolean
  papers: Paper[]
  /**
   * The screening configuration when this is a screening project, else null.
   * A screening project's `schema` is *derived* from this (see
   * `src/screening/schema.ts`); `config.schema` in the file is ignored, so the
   * two can never drift.
   */
  screening: ScreeningConfig | null
  /** Additional top-level fields preserved verbatim on save. */
  extra: Record<string, unknown>
  /** Strict mode settings; absent when the file has none. See `model/strict.ts`. */
  strict?: StrictConfig
  /** Who may correct paper metadata, and where it is stored. Absent means `off`. */
  metadataEdit?: MetadataEditMode
  pdfFolder?: string
  crossrefLookup?: boolean
}

// [impl->req~llm-470~1]
// [impl->req~llm-650~1]
/**
 * The seat id the AI writes into, or `null` when there is none. Always the
 * last configured seat (`String(project.reviewers)`) — never a separately
 * stored id — so there is nothing to merge-conflict over which number it is.
 *
 * Effective only when AI is actually usable on this project: `aiEnabled` and
 * `aiSeat` both on and at least 2 reviewers configured. A screening project
 * qualifies too: the AI's include/exclude proposals go into that seat.
 */
export function aiSeatId(project: Pick<Project, 'aiSeat' | 'aiEnabled' | 'reviewers' | 'screening'>): string | null {
  if (!project.aiSeat || !project.aiEnabled || project.reviewers < 2) return null
  return String(project.reviewers)
}

// [impl->req~dat-40~1]
// [impl->req~llm-470~1]
/**
 * The display label for a reviewer seat: "Consolidation" for that seat, "AI
 * (Reviewer N)" for the seat `aiSeatId` names, else the plain "Reviewer N".
 * The one place every "Reviewer N" label in the UI goes through, so the AI
 * seat is never accidentally shown as an ordinary human reviewer.
 */
export function seatLabel(project: Pick<Project, 'aiSeat' | 'aiEnabled' | 'reviewers' | 'screening'>, seatId: string): string {
  if (seatId === 'consolidation') return t('store.seat.consolidation')
  return seatId === aiSeatId(project) ? t('store.seat.ai', { seat: seatId }) : t('store.seat.reviewer', { seat: seatId })
}

export class ProjectLoadError extends Error {
  details: string[]
  constructor(message: string, details: string[] = []) {
    super(message)
    this.details = details
  }
}

const KNOWN_PAPER_KEYS = new Set([
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
  'reviews',
  'aiUsage',
  'equal',
  'alignment',
  'consolidationSync',
  'marks',
  'reviewMarks',
  'finished',
  'reviewsFinished',
  'reviewMetadata',
  'reviewsLock',
  'schemaVersions',
])
// [impl->req~dat-270~1]
// [impl->req~dat-80~1]
// [impl->req~dat-260~1]
/** Exported so `editorStore.ts`'s root-extra split reuses this exact list
 *  rather than a second hand-maintained copy. */
export const KNOWN_ROOT_KEYS = new Set([
  'version',
  'title',
  'provenance',
  'protocol',
  'schemaInfo',
  'schemaVersion',
  'schemaHistory',
  'annotationsDir',
  'config',
  'papers',
])

// [impl->req~dat-270~1]
/**
 * Parse `reviews` defensively: the file is hand-editable, so a malformed entry
 * is dropped, never thrown over. Only keys that look like a reviewer number
 * are kept — anything else is unreachable dead weight.
 */
function parseReviews(raw: unknown, schema: ResolvedDef[]): Record<string, AnnotationValueTree> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  // [impl->req~dat-280~1]
  const out: Record<string, AnnotationValueTree> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[1-9]\d*$/.test(key)) continue
    out[key] = normalizeTree(schema, value as AnnotationValueTree | undefined)
  }
  return out
}

/**
 * `parseReviews`, plus a skeleton for every reviewer `1..reviewerCount` with no
 * tree yet — so a reviewer's *first* annotation is a value-on-an-existing-line
 * change for git, not a brand-new field appearing from nowhere.
 *
 * Never removes a key `parseReviews` already kept, including a reviewer number
 * *above* `reviewerCount`: lowering the count must not be what deletes that
 * reviewer's tree.
 *
 * Single-reviewer projects are untouched: `reviews` stays `{}`.
 */
function normalizeReviews(
  raw: unknown,
  schema: ResolvedDef[],
  reviewerCount: number,
): Record<string, AnnotationValueTree> {
  const existing = parseReviews(raw, schema)
  if (reviewerCount <= 1) return existing
  const out: Record<string, AnnotationValueTree> = { ...existing }
  for (let i = 1; i <= reviewerCount; i++) {
    const key = String(i)
    if (!(key in out)) out[key] = normalizeTree(schema, undefined)
  }
  return out
}

/**
 * Parse `reviewsFinished` defensively: drops keys that aren't a reviewer
 * number, and any value that isn't literally `true` (the flag is a
 * declaration; "present but not `true`" must mean "not declared").
 *
 * Unlike `normalizeReviews`, no skeleton is filled in: `false` *is* the absent
 * state here, so a missing key already reads correctly.
 */
function parseReviewsFinished(raw: unknown): Record<string, boolean> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[1-9]\d*$/.test(key) || value !== true) continue
    out[key] = true
  }
  return out
}

// [impl->req~con-540~1]
/** Parse `reviewsLock`: keeps reviewer-number keys and string times only. */
function parseReviewsLock(raw: unknown): Record<string, SeatLock> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, SeatLock> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[1-9]\d*$/.test(key) || typeof value !== 'object' || value === null) continue
    const { finishedAt, reopenedAt } = value as Record<string, unknown>
    const lock: SeatLock = {
      ...(typeof finishedAt === 'string' ? { finishedAt } : {}),
      ...(typeof reopenedAt === 'string' ? { reopenedAt } : {}),
    }
    if (Object.keys(lock).length > 0) out[key] = lock
  }
  return out
}

function reviewsLockField(m: Record<string, SeatLock> | undefined): { reviewsLock?: Record<string, SeatLock> } {
  return m && Object.keys(m).length > 0 ? { reviewsLock: m } : {}
}

/**
 * Parse `aiUsage` defensively: the file is hand-editable, so a malformed entry
 * must be dropped, never thrown over — the same rule `annotations` follows.
 */
/** Parse the judge sub-record, dropping it (not the whole entry) if malformed. */
function parseAiUsageJudge(raw: unknown): { provider: string; model: string } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  return typeof r.provider === 'string' && typeof r.model === 'string'
    ? { provider: r.provider, model: r.model }
    : undefined
}

/** Parse the verdicts sub-record, same drop-not-discard rule as `parseAiUsageJudge`. */
function parseAiUsageVerdicts(raw: unknown): { accept: number; revise: number; reject: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const keys = ['accept', 'revise', 'reject'] as const
  if (!keys.every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))) return undefined
  return { accept: r.accept as number, revise: r.revise as number, reject: r.reject as number }
}

// [impl->req~llm-240~1]
function parseAiUsage(raw: unknown): AiUsageRecord[] {
  if (!Array.isArray(raw)) return []
  const out: AiUsageRecord[] = []
  for (const entry of raw) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).provider === 'string' &&
      typeof (entry as Record<string, unknown>).model === 'string' &&
      typeof (entry as Record<string, unknown>).appliedAt === 'string'
    ) {
      const e = entry as Record<string, unknown>
      const record: AiUsageRecord = {
        provider: e.provider as string,
        model: e.model as string,
        appliedAt: e.appliedAt as string,
      }
      // Each optional field is dropped on its own if malformed — the base
      // record above is never discarded for a bad extra, same rule as the
      // rest of this file's hand-editable sub-records.
      if (e.mode === 'prompt' || e.mode === 'agent' || e.mode === 'classify' || e.mode === 'screening') {
        record.mode = e.mode
      }
      const judge = parseAiUsageJudge(e.judge)
      if (judge) record.judge = judge
      if (typeof e.rounds === 'number' && Number.isFinite(e.rounds)) record.rounds = e.rounds
      const verdicts = parseAiUsageVerdicts(e.verdicts)
      if (verdicts) record.verdicts = verdicts
      if (typeof e.fewShot === 'number' && Number.isFinite(e.fewShot)) record.fewShot = e.fewShot
      if (typeof e.edited === 'number' && Number.isFinite(e.edited)) record.edited = e.edited
      if (typeof e.rechecked === 'number' && Number.isFinite(e.rechecked)) record.rechecked = e.rechecked
      if (typeof e.webSearches === 'number' && Number.isFinite(e.webSearches)) record.webSearches = e.webSearches
      if (typeof e.unverifiedQuotes === 'number' && Number.isFinite(e.unverifiedQuotes)) {
        record.unverifiedQuotes = e.unverifiedQuotes
      }
      if (typeof e.promptVersion === 'string' && e.promptVersion) record.promptVersion = e.promptVersion
      if (typeof e.reviewer === 'string') record.reviewer = e.reviewer
      out.push(record)
    }
  }
  return out
}

/**
 * Parse `equal` defensively, same rule as `reviews`/`aiUsage`: non-strings are
 * dropped, never thrown over. Deduped since the mark is really a set, so a
 * hand-edited duplicate doesn't toggle differently from a clean one.
 */
function parseEqual(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string' || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

// [impl->req~scr-40~1]
// [impl->req~scr-50~1]
/**
 * Parse `config.screening` defensively-but-strictly. Unlike `reviews`/`equal`,
 * a broken value here can't be degraded past: the reasons *are* the schema's
 * enum, so an empty result is a load error, not an empty list. Trimmed and
 * deduped since the list is really a set.
 */
function parseScreening(raw: unknown): ScreeningConfig | null {
  if (raw === undefined) return null
  const reasonsRaw = Array.isArray((raw as { reasons?: unknown })?.reasons)
    ? ((raw as { reasons: unknown[] }).reasons)
    : []
  const seen = new Set<string>()
  const reasons: string[] = []
  for (const entry of reasonsRaw) {
    if (typeof entry !== 'string') continue
    // [impl->req~edt-70~1]
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    reasons.push(trimmed)
  }
  if (reasons.length === 0) {
    throw new ProjectLoadError(t('store.load.screeningInvalid'), [t('store.schema.reasonsRequired')])
  }
  return { reasons }
}

/**
 * Parse `provenance` defensively — hand-editable, so a malformed record
 * degrades to "no provenance", never thrown over, unlike `parseScreening`
 * (whose reasons are the schema itself and can't degrade past empty).
 * Rejected all-or-nothing: a half-parsed record (e.g. `counts` missing a
 * field) would be misleading, not just incomplete.
 *
 * Exported so `editorStore.ts`'s `editorStateFromOpened` shares this exact
 * parse rather than a second copy.
 */
/**
 * Parse `protocol` defensively, same degrade-not-throw rule as
 * `parseProvenance`, but field-by-field rather than all-or-nothing: a single
 * malformed key (e.g. `databases` as a string) shouldn't discard the rest of
 * the authored protocol. Degrades to `null` once every field is dropped, so
 * an empty `{}` never round-trips as a stray key.
 *
 * Exported so `editorStore.ts` shares this exact parse.
 */
function parseStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const list = raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
  return list.length > 0 ? list : undefined
}

export function parseProtocol(raw: unknown): ProjectProtocol | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const protocol: ProjectProtocol = {}
  const rqs = parseStringList(r.researchQuestions)
  if (rqs) protocol.researchQuestions = rqs
  const searches = parseStringList(r.searchStrings)
  if (searches) protocol.searchStrings = searches
  const dbs = parseStringList(r.databases)
  if (dbs) protocol.databases = dbs
  if (typeof r.searchDate === 'string' && r.searchDate.trim() !== '') protocol.searchDate = r.searchDate
  if (typeof r.notes === 'string' && r.notes.trim() !== '') protocol.notes = r.notes
  return Object.keys(protocol).length > 0 ? protocol : null
}

/**
 * Parse `schemaInfo` defensively — hand-editable, so anything other than a
 * non-blank string degrades to `null` rather than throwing. Exported so
 * `editorStore.ts` shares this exact parse.
 */
export function parseSchemaInfo(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null
}

export function parseProvenance(raw: unknown): ProjectProvenance | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.kind !== 'screening-import') return null
  if (typeof r.importedAt !== 'string') return null
  const source = r.source
  if (typeof source !== 'object' || source === null) return null
  const src = source as Record<string, unknown>
  if (typeof src.file !== 'string') return null
  if (src.title !== undefined && typeof src.title !== 'string') return null
  const counts = r.counts
  if (typeof counts !== 'object' || counts === null) return null
  const c = counts as Record<string, unknown>
  // [impl->req~dat-166~1]
  const countKeys = ['included', 'undecided', 'excluded', 'carried'] as const
  if (!countKeys.every((k) => typeof c[k] === 'number' && Number.isFinite(c[k]))) return null
  return {
    kind: 'screening-import',
    source: { file: src.file, ...(src.title !== undefined ? { title: src.title as string } : {}) },
    importedAt: r.importedAt,
    counts: {
      included: c.included as number,
      undecided: c.undecided as number,
      excluded: c.excluded as number,
      carried: c.carried as number,
    },
  }
}

/**
 * Structural equality for plain JSON: object keys are order-independent,
 * array elements are order-sensitive (reordering genuinely changes meaning).
 * Exported for `src/git/merge.ts`, which needs the identical notion for
 * three-way merges — a second implementation would be a bug waiting to happen.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqualJson(v, b[i]))
  }
  const ak = Object.keys(a as Record<string, unknown>)
  const bk = Object.keys(b as Record<string, unknown>)
  if (ak.length !== bk.length) return false
  return ak.every(
    (k) => k in (b as Record<string, unknown>) && deepEqualJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

/**
 * Parse raw JSON text (or an already-parsed object) into a validated,
 * normalized Project. Throws {@link ProjectLoadError} with friendly details.
 */
/**
 * Deeper than any real project and far below where any of the app's recursive
 * walkers give out (the shallowest, zod's validation, goes at ~700).
 */
const MAX_JSON_DEPTH = 200

/** Is `value` nested deeper than `limit`? Iterative, so it cannot itself
 *  overflow on the very input it exists to reject. */
function exceedsDepth(value: unknown, limit: number): boolean {
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }]
  while (stack.length > 0) {
    const { v, d } = stack.pop()!
    if (v === null || typeof v !== 'object') continue
    if (d >= limit) return true
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      stack.push({ v: child, d: d + 1 })
    }
  }
  return false
}

// [impl->req~edt-110~1]
export function loadProject(input: string | unknown): Project {
  // [impl->req~dat-20~1]
  let data: unknown
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input)
    } catch (err) {
      throw new ProjectLoadError(t('store.load.notJson'), [String(err)])
    }
  } else {
    data = input
  }

  // Depth check first: nearly every traversal here is recursive (zod,
  // resolveDefs, normalizeTree, deepEqualJson, serializeProject) and overflows
  // the stack at a few hundred levels — a real file nested 704 deep threw a raw
  // RangeError that escaped this function's ProjectLoadError contract. One
  // check here covers all of them, including `extra`'s unbounded key depth.
  if (exceedsDepth(data, MAX_JSON_DEPTH)) {
    throw new ProjectLoadError(t('store.load.tooDeep'), [t('store.load.tooDeepDetail', { max: MAX_JSON_DEPTH })])
  }

  // [impl->req~dat-10~1]
  // [impl->req~llm-80~1]
  let raw
  try {
    raw = projectSchema.parse(data)
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new ProjectLoadError(
        t('store.load.structure'),
        err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      )
    }
    // Belt and braces: depth guard above should make this unreachable, but a
    // stack overflow must never escape as anything but ProjectLoadError.
    if (err instanceof RangeError) {
      throw new ProjectLoadError(t('store.load.tooDeep'), [String(err)])
    }
    throw err
  }

  // A screening project's schema is derived from `config.screening.reasons`
  // every load, never read from the file, so a hand-edited reason list can't
  // disagree with the dropdown shown. `raw.config.schema!` is safe: zod's
  // `superRefine` guarantees it's present whenever `screening` is null.
  const screening = parseScreening((raw.config as { screening?: unknown }).screening)
  // [impl->req~llm-80~1]
  // [impl->req~dat-30~1]
  let schema: ResolvedDef[]
  try {
    schema = resolveSchema(screening ? screeningSchemaDefs(screening) : raw.config.schema!)
  } catch (err) {
    if (err instanceof SchemaError) {
      throw new ProjectLoadError(t('store.load.schemaInvalid'), [err.message])
    }
    throw err
  }

  // Duplicate paper ids would break selection/navigation.
  const ids = new Set<string>()
  for (const p of raw.papers) {
    if (ids.has(p.id)) {
      throw new ProjectLoadError(t('store.load.duplicatePaper'), [t('store.load.duplicatePaperDetail', { id: p.id })])
    }
    ids.add(p.id)
  }

  const strict = parseStrictConfig((data as { config?: unknown }).config, ids)
  if (strict.problems.length > 0) {
    throw new ProjectLoadError(t('store.load.strictInvalid'), strict.problems)
  }

  const schemaVersion = parseSchemaVersion((data as { schemaVersion?: unknown }).schemaVersion)
  const schemaHistory = parseSchemaHistory((data as { schemaHistory?: unknown }).schemaHistory)
  const rawAnnotationsDir = (data as { annotationsDir?: unknown }).annotationsDir
  // [impl->req~dat-165~1]
  const annotationsDir =
    typeof rawAnnotationsDir === 'string' && annotationsDirProblem(rawAnnotationsDir) === null ? rawAnnotationsDir : null

  // [impl->req~dat-165~1]
  const papers: Paper[] = raw.papers.map((p) => {
    // Carry each file's answers across the renames and moves made since it
    // was written — see `model/schemaVersion.ts`. A file with no version
    // predates versioning, so every recorded move is newer than it.
    const versions = parseFileVersions((p as { schemaVersions?: unknown }).schemaVersions)
    const unknownSchemaFiles: string[] = []
    const migrate = <T,>(key: string, value: T, apply: (v: T, m: SchemaMove) => T): T => {
      // [impl->req~dat-50~1]
      const pending = pendingMoves(schemaHistory, versions[key] ?? null, schemaVersion)
      if (pending === 'unknown') {
        unknownSchemaFiles.push(key)
        return value
      }
      return pending.reduce(apply, value)
    }
    const tree = (key: string, v: unknown) =>
      migrate(key, v as AnnotationValueTree | undefined, moveInTree)
    // [impl->req~dat-50~1]
    const rawReviews = (p as { reviews?: unknown }).reviews
    const reviews =
      typeof rawReviews === 'object' && rawReviews !== null && !Array.isArray(rawReviews)
        ? Object.fromEntries(Object.entries(rawReviews).map(([k, v]) => [k, tree(`review-${k}`, v)]))
        : rawReviews
    // [impl->req~dat-100~1]
    // [impl->req~dat-290~1]
    const reviewMarks = Object.fromEntries(
      Object.entries(parseReviewMarks((p as { reviewMarks?: unknown }).reviewMarks)).map(([k, v]) => [
        k,
        migrate(`marks-${k}`, v, moveInMarks),
      ]),
    )
    return {
    id: p.id,
    title: p.title,
    authors: p.authors ?? [],
    doi: p.doi,
    year: parseYear(p.year),
    venue: p.venue?.trim() || undefined,
    abstract: p.abstract,
    // Defensive against a hand-edited or stale file: the flag means nothing
    // without an abstract for it to describe, so it is dropped rather than
    // trusted whenever `abstract` itself is empty.
    abstractFromPdf: p.abstract && p.abstractFromPdf === true ? true : undefined,
    pdf: p.pdf,
    annotations: normalizeTree(schema, tree('consolidated', p.annotations)),
    reviews: normalizeReviews(reviews, schema, raw.config.reviewers ?? 1),
    aiUsage: parseAiUsage(p.aiUsage),
    equal: parseEqual(p.equal),
    alignment: parseAlignment((p as { alignment?: unknown }).alignment),
    consolidationSync:
      typeof (p as { consolidationSync?: unknown }).consolidationSync === 'string'
        ? ((p as { consolidationSync?: string }).consolidationSync as string)
        : undefined,
    marks: migrate('marks-consolidated', parseMarks((p as { marks?: unknown }).marks), moveInMarks),
    reviewMarks,
    // Only a literal `true` declares anything — see `parseReviewsFinished`.
    finished: (p as { finished?: unknown }).finished === true,
    reviewsFinished: parseReviewsFinished((p as { reviewsFinished?: unknown }).reviewsFinished),
    ...reviewMetadataField(parseReviewMetadata((p as { reviewMetadata?: unknown }).reviewMetadata)),
    ...reviewsLockField(parseReviewsLock((p as { reviewsLock?: unknown }).reviewsLock)),
    extra: extractExtra(p, KNOWN_PAPER_KEYS),
    ...(unknownSchemaFiles.length > 0 ? { unknownSchemaFiles } : {}),
    }
  })

  return {
    version: raw.version ?? 1,
    title: raw.title,
    provenance: parseProvenance(raw.provenance),
    protocol: parseProtocol(raw.protocol),
    schemaInfo: parseSchemaInfo(raw.schemaInfo),
    schema,
    schemaVersion,
    schemaHistory,
    annotationsDir,
    ...(rawAnnotationsDir !== undefined && annotationsDir === null
      ? { refusedAnnotationsDir: String(rawAnnotationsDir) }
      : {}),
    // Absent means disabled; only an explicit `true` allows AI.
    aiEnabled: raw.config.ai === true,
    // Absent means enabled; only an explicit `false`
    // opts out, so a file predating this option behaves exactly as before.
    finishCheckbox: (raw.config as { finishCheckbox?: unknown }).finishCheckbox !== false,
    // Absent or 1 means single-reviewer; zod already bounds a present value to [1, 10].
    reviewers: raw.config.reviewers ?? 1,
    // Absent means no AI seat; only an explicit `true` opts in.
    aiSeat: (raw.config as { aiSeat?: unknown }).aiSeat === true,
    papers,
    screening,
    extra: extractExtra(raw, KNOWN_ROOT_KEYS),
    ...(strict.strict ? { strict: strict.strict } : {}),
    ...metadataEditField(parseMetadataEditMode(((data as { config?: { metadataEdit?: unknown } }).config ?? {}).metadataEdit)),
    ...pdfFolderFields(
      parsePdfFolder((data as { config?: { pdfFolder?: unknown } }).config?.pdfFolder),
      (data as { config?: { crossrefLookup?: unknown } }).config?.crossrefLookup === true,
    ),
  }
}

// [impl->req~dat-530~1]
// [impl->req~dat-560~1]
function pdfFolderFields(pdfFolder: string | undefined, crossrefLookup: boolean | undefined): { pdfFolder?: string; crossrefLookup?: boolean } {
  return { ...(pdfFolder ? { pdfFolder } : {}), ...(crossrefLookup ? { crossrefLookup: true } : {}) }
}

function reviewMetadataField(m: Record<string, SeatMetadata> | undefined): { reviewMetadata?: Record<string, SeatMetadata> } {
  return m && Object.keys(m).length > 0 ? { reviewMetadata: m } : {}
}

function metadataEditField(mode: MetadataEditMode | undefined): { metadataEdit?: MetadataEditMode } {
  return mode && mode !== 'off' ? { metadataEdit: mode } : {}
}

/** The root keys naming the schema version, written once there is one. */
function schemaVersionKeys(project: Project): Record<string, unknown> {
  return {
    ...(project.annotationsDir ? { annotationsDir: project.annotationsDir } : {}),
    ...(project.schemaVersion ? { schemaVersion: project.schemaVersion } : {}),
    ...(project.schemaHistory.length > 0 ? { schemaHistory: project.schemaHistory } : {}),
  }
}

/** A paper's per-file schema versions (see `assembleLegacyProjectJson`);
 *  `null` for a file that predates versioning. */
function parseFileVersions(raw: unknown): Record<string, string | null> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string | null> = {}
  for (const [k, v] of Object.entries(raw)) out[k] = typeof v === 'string' && v !== '' ? v : null
  return out
}

// [impl->req~edt-110~1]
/**
 * Serialize a Project back to the on-disk JSON shape. `config` is written from
 * the resolved schema, annotations are pruned of trailing empties, and any
 * preserved `extra` fields are re-emitted.
 */
export function serializeProject(project: Project): string {
  const out: Record<string, unknown> = {
    version: project.version,
    ...(project.title ? { title: project.title } : {}),
    // Only written when this project was actually imported from another —
    // an ordinary project stays exactly as clean as before this field existed.
    ...(project.provenance ? { provenance: project.provenance } : {}),
    // Likewise only written when a protocol was actually authored.
    ...(project.protocol ? { protocol: project.protocol } : {}),
    // Likewise only written when a schema comment was actually authored.
    ...(project.schemaInfo ? { schemaInfo: project.schemaInfo } : {}),
    ...schemaVersionKeys(project),
    // `ai`/`reviewers` are only written when they differ from the default, so
    // an ordinary or single-reviewer file stays exactly as clean as before.
    config: {
      // Derived projection of `config.screening.reasons` for a screening
      // project (see `Project.screening`), written so the file stays
      // self-describing.
      schema: dehydrateSchema(project.schema),
      ...(project.aiEnabled ? { ai: true } : {}),
      ...(project.finishCheckbox ? {} : { finishCheckbox: false }),
      ...(project.reviewers > 1 ? { reviewers: project.reviewers } : {}),
      ...(project.aiSeat ? { aiSeat: true } : {}),
      ...(project.screening ? { screening: { reasons: project.screening.reasons } } : {}),
      ...strictConfigJson(project.strict),
      ...metadataEditField(project.metadataEdit),
      ...pdfFolderFields(project.pdfFolder, project.crossrefLookup),
    },
    papers: [...project.papers].sort(comparePapers).map((p) => {
      const paper: Record<string, unknown> = {
        id: p.id,
        title: p.title,
        authors: p.authors,
      }
      // Placed after authors, before doi, so a hand-read file reads like a
      // citation: who, when, where, then the identifiers.
      if (p.year !== undefined) paper.year = p.year
      if (p.venue) paper.venue = p.venue
      if (p.doi !== undefined) paper.doi = p.doi
      if (p.abstract !== undefined && p.abstract !== '') paper.abstract = p.abstract
      // Only written alongside a real abstract and only when true, so a typed
      // or imported abstract stays as clean as before this field existed.
      if (p.abstractFromPdf && p.abstract) paper.abstractFromPdf = true
      paper.pdf = p.pdf
      paper.annotations = serializedTree(project.schema, p.annotations)
      // Single-reviewer papers have no reviewer trees, so `reviews` stays empty
      // and is omitted below; `normalizeReviews` gives multi-reviewer papers a
      // skeleton for every reviewer, so this is never empty for them.
      // [impl->req~dat-170~1]
      // [impl->req~plt-40~1]
      const reviewKeys = Object.keys(p.reviews)
      if (reviewKeys.length > 0) {
        paper.reviews = Object.fromEntries(
          reviewKeys.sort((a, b) => Number(a) - Number(b)).map((k) => [k, serializedTree(project.schema, p.reviews[k])]),
        )
      }
      // Only written when non-empty, so a paper AI has never touched stays clean.
      if (p.aiUsage.length > 0) paper.aiUsage = p.aiUsage
      // Only written when non-empty, so a paper with no equality marks stays clean.
      if (p.equal.length > 0) paper.equal = p.equal
      // Same rule: an unmatched paper stays exactly as clean as before this
      // field existed.
      if (Object.keys(p.alignment).length > 0) paper.alignment = p.alignment
      // Same rule again: a paper Consolidation has never run on stays clean.
      if (p.consolidationSync) paper.consolidationSync = p.consolidationSync
      // Only written when non-empty, so a paper nobody has highlighted stays clean.
      if (p.marks.length > 0) paper.marks = p.marks
      const reviewMarkKeys = Object.keys(p.reviewMarks).filter((k) => p.reviewMarks[k].length > 0)
      if (reviewMarkKeys.length > 0) {
        paper.reviewMarks = Object.fromEntries(
          reviewMarkKeys.sort((a, b) => Number(a) - Number(b)).map((k) => [k, p.reviewMarks[k]]),
        )
      }
      // Only written when declared, so an unfinished paper stays as clean as
      // before this field existed — same rule as `aiUsage`/`equal`/`marks`.
      if (p.finished) paper.finished = true
      const finishedKeys = Object.keys(p.reviewsFinished).filter((k) => p.reviewsFinished[k])
      if (finishedKeys.length > 0) {
        paper.reviewsFinished = Object.fromEntries(
          finishedKeys.sort((a, b) => Number(a) - Number(b)).map((k) => [k, true]),
        )
      }
      Object.assign(paper, reviewMetadataField(p.reviewMetadata))
      Object.assign(paper, reviewsLockField(p.reviewsLock))
      // Every tree held here is at the project's version — it was carried
      // there on load — so reading this text back must not move it again.
      if (project.schemaVersion) {
        const v = project.schemaVersion
        paper.schemaVersions = {
          consolidated: v,
          'marks-consolidated': v,
          ...Object.fromEntries(Object.keys(p.reviews).map((k) => [`review-${k}`, v])),
          ...Object.fromEntries(Object.keys(p.reviewMarks).map((k) => [`marks-${k}`, v])),
        }
      }
      return { ...paper, ...p.extra }
    }),
    ...project.extra,
  }
  return JSON.stringify(out, null, 2)
}

/** Empty normalized trees exist in memory to bind the form to the schema, but
 * do not belong in a project file until a reviewer has recorded an answer. */
function serializedTree(schema: ResolvedDef[], tree: AnnotationValueTree): AnnotationValueTree {
  // Orphans survive even when nothing in the current schema is answered —
  // otherwise removing the one field a reviewer had filled in would still be
  // what deletes their work. See `orphanedNodes`.
  return hasContent(schema, tree) ? pruneTree(schema, tree) : {}
}

/** Does this tree hold anything worth a file on disk — a real answer, or
 *  answers orphaned by a schema edit at any depth? `hasAnnotations` alone
 *  would drop the file, and with it the orphans. */
function hasContent(schema: ResolvedDef[], tree: AnnotationValueTree): boolean {
  return hasAnnotations(schema, tree) || treeHoldsOrphans(schema, tree)
}

/**
 * On-disk layout: `project.json` holds only paper metadata; `annotations`,
 * `reviews`, `aiUsage`, `equal` live under a sibling `annotations/<paperId>/`
 * folder, one file per reviewer plus one consolidated file — so two reviewers
 * (or the same paper's different slots) never touch the same file and cause
 * merge conflicts.
 *
 * A screening project uses `screening-<n>.json`/`screening-consolidated.json`
 * instead of `reviewer-<n>.json`/`consolidated.json` — same layout, prefix
 * only so the two kinds of decision are distinguishable in the folder.
 *
 * `aiUsage`/`equal` always ride in the consolidated file even in a
 * multi-reviewer project — both are paper-wide, low-conflict-risk records,
 * not per-reviewer trees.
 * ponytail: if AI usage ever needs attribution to a specific reviewer's edit,
 * give `Paper.aiUsage` entries a `reviewer` field first — this placement can
 * stay as-is either way.
 */
export interface ProjectFileEntry {
  /** Relative to the project's `annotations/` folder, e.g.
   *  `"p1/reviewer-2.json"` or `"p1/consolidated.json"` (`"p1/screening-2.json"` /
   *  `"p1/screening-consolidated.json"` for a screening project). */
  relPath: string
  /** `null` means "this file should not exist" (the tree/records it would
   *  hold are all empty) — the caller deletes it if present on disk. */
  text: string | null
}

// [impl->req~edt-110~1]
/**
 * Split a `Project` into the meta-only `project.json` body and the set of
 * per-paper annotation files it should reconcile on disk. Pure and
 * side-effect-free — `src-tauri/src/project.rs` does the actual fs writes/deletes, so
 * this stays unit-testable without touching a filesystem.
 */
export function splitProjectFiles(project: Project): { meta: unknown; files: ProjectFileEntry[] } {
  const files: ProjectFileEntry[] = []
  // Each file says which schema version its answers are written against.
  const stamp = project.schemaVersion ? { schemaVersion: project.schemaVersion } : {}
  const reviewerName = project.screening ? 'screening' : 'reviewer'
  const consolidatedName = project.screening ? 'screening-consolidated' : 'consolidated'
  const metaPapers = [...project.papers].sort(comparePapers).map((p) => {
    const paper: Record<string, unknown> = { id: p.id, title: p.title, authors: p.authors }
    if (p.year !== undefined) paper.year = p.year
    if (p.venue) paper.venue = p.venue
    if (p.doi !== undefined) paper.doi = p.doi
    if (p.abstract !== undefined && p.abstract !== '') paper.abstract = p.abstract
    if (p.abstractFromPdf && p.abstract) paper.abstractFromPdf = true
    paper.pdf = p.pdf

    // Configured range plus any reviewer number already kept despite falling
    // outside it — lowering `config.reviewers` must not be what deletes that
    // reviewer's tree (same promise `normalizeReviews` makes in memory).
    const reviewerSlots = new Set<number>()
    if (project.reviewers > 1) {
      for (let k = 1; k <= project.reviewers; k++) reviewerSlots.add(k)
    }
    for (const key of Object.keys(p.reviews)) reviewerSlots.add(Number(key))
    for (const key of Object.keys(p.reviewMarks)) reviewerSlots.add(Number(key))
    for (const key of Object.keys(p.reviewsFinished)) reviewerSlots.add(Number(key))
    for (const key of Object.keys(p.reviewMetadata ?? {})) reviewerSlots.add(Number(key))
    for (const key of Object.keys(p.reviewsLock ?? {})) reviewerSlots.add(Number(key))
    if (reviewerSlots.size > 0) {
      for (const k of [...reviewerSlots].sort((a, b) => a - b)) {
        const tree = p.reviews[String(k)]
        const has = tree !== undefined && hasContent(project.schema, tree)
        // Rides in the same per-reviewer file as that reviewer's tree, so it
        // never collides with another reviewer's save; it can also keep the
        // file alive alone — ticking the box then clearing a field still said
        // something, and dropping the file would un-say it.
        const finished = p.reviewsFinished[String(k)] === true
        const metadata = p.reviewMetadata?.[String(k)]
        const lock = p.reviewsLock?.[String(k)]
        files.push({
          relPath: `${p.id}/${reviewerName}-${k}.json`,
          text:
            has || finished || metadata || lock
              ? JSON.stringify(
                  {
                    ...stamp,
                    ...(has ? { annotations: serializedTree(project.schema, tree!) } : {}),
                    ...(finished ? { finished: true } : {}),
                    ...(metadata?.overrides ? { metadataOverrides: metadata.overrides } : {}),
                    ...(metadata?.ignored ? { metadataIgnored: metadata.ignored } : {}),
                    ...(lock?.finishedAt ? { finishedAt: lock.finishedAt } : {}),
                    ...(lock?.reopenedAt ? { reopenedAt: lock.reopenedAt } : {}),
                  },
                  null,
                  2,
                )
              : null,
        })
        const marks = p.reviewMarks[String(k)] ?? []
        files.push({
          relPath: `${p.id}/${marksFileName(project.screening !== null, String(k))}`,
          text: marks.length > 0 ? JSON.stringify({ ...stamp, marks }, null, 2) : null,
        })
      }
    }

    const consolidated: Record<string, unknown> = {}
    // [impl->req~plt-50~1]
    const hasConsolidatedAnnotations = hasContent(project.schema, p.annotations)
    if (hasConsolidatedAnnotations) consolidated.annotations = serializedTree(project.schema, p.annotations)
    if (p.aiUsage.length > 0) consolidated.aiUsage = p.aiUsage
    if (p.equal.length > 0) consolidated.equal = p.equal
    // Consolidation's own bookkeeping about all reviewers' entries — belongs
    // in the consolidated file since it can't be split into per-reviewer pieces.
    if (Object.keys(p.alignment).length > 0) consolidated.alignment = p.alignment
    // Same reason: it describes every reviewer's work at once.
    if (p.consolidationSync) consolidated.consolidationSync = p.consolidationSync
    if (p.finished) consolidated.finished = true
    files.push({
      relPath: `${p.id}/${consolidatedName}.json`,
      text: Object.keys(consolidated).length > 0 ? JSON.stringify({ ...stamp, ...consolidated }, null, 2) : null,
    })
    // Marks are reading notes, not screening/reviewer decisions, so they get
    // their own file family regardless of screening vs. annotation mode.
    files.push({
      relPath: `${p.id}/${marksFileName(project.screening !== null, 'consolidated')}`,
      text: p.marks.length > 0 ? JSON.stringify({ ...stamp, marks: p.marks }, null, 2) : null,
    })

    return { ...paper, ...p.extra }
  })

  const meta = {
    version: project.version,
    ...(project.title ? { title: project.title } : {}),
    ...(project.provenance ? { provenance: project.provenance } : {}),
    ...(project.protocol ? { protocol: project.protocol } : {}),
    ...(project.schemaInfo ? { schemaInfo: project.schemaInfo } : {}),
    ...schemaVersionKeys(project),
    config: {
      schema: dehydrateSchema(project.schema),
      ...(project.aiEnabled ? { ai: true } : {}),
      ...(project.finishCheckbox ? {} : { finishCheckbox: false }),
      ...(project.reviewers > 1 ? { reviewers: project.reviewers } : {}),
      ...(project.aiSeat ? { aiSeat: true } : {}),
      ...(project.screening ? { screening: { reasons: project.screening.reasons } } : {}),
      ...strictConfigJson(project.strict),
      ...metadataEditField(project.metadataEdit),
      ...pdfFolderFields(project.pdfFolder, project.crossrefLookup),
    },
    papers: metaPapers,
    ...project.extra,
  }
  return { meta, files }
}

// [impl->req~plt-61~1]
/**
 * May the file currently holding `text` be deleted when the project no longer
 * needs that slot? Yes for empty/parseable JSON; no otherwise — an
 * unparseable file (e.g. mid git-conflict-markers) must survive, since the
 * loader treats it as absent and a save would otherwise unlink the only copy
 * of that reviewer's work.
 */
export function isDeletableAnnotationText(text: string): boolean {
  if (text.trim() === '') return true
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Does this parsed `project.json` use the old single-file shape (papers carry
 * `annotations`/`reviews` inline) rather than the new meta-only shape? Used to
 * decide whether a project needs migrating to the split layout on open.
 */
export function isLegacyProjectShape(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const papers = (raw as { papers?: unknown }).papers
  if (!Array.isArray(papers)) return false
  return papers.some(
    (p) => typeof p === 'object' && p !== null && ('annotations' in p || 'reviews' in p),
  )
}

const REVIEWER_FILE = /^(?:reviewer|screening)-(\d+)\.json$/

// [impl->req~dat-172~1]
/**
 * A PDF-highlight file's name. Screening projects have their own
 * (`screening-marks-*`), like their decision files: a screening project and an
 * annotation project over the same papers can then share a folder without
 * ever writing the same file. `seat` is a reviewer number or `consolidated`.
 */
export function marksFileName(screening: boolean, seat: string): string {
  return `${screening ? 'screening-marks' : 'marks'}-${seat}.json`
}

// [impl->req~dat-172~1]
/**
 * The seat a highlight file holds for a project of this kind, or `null` when
 * it is not one. A screening project's highlight file from before they had
 * their own name (`marks-*`) is recognised as `legacy`: whether it really is
 * the screening project's is the caller's decision.
 */
export function parseMarksFileName(name: string, screening: boolean): { seat: string; legacy: boolean } | null {
  const own = (screening ? /^screening-marks-(\d+|consolidated)\.json$/ : /^marks-(\d+|consolidated)\.json$/).exec(name)
  if (own) return { seat: own[1], legacy: false }
  const old = screening ? /^marks-(\d+|consolidated)\.json$/.exec(name) : null
  return old ? { seat: old[1], legacy: true } : null
}

/**
 * The reverse of `splitProjectFiles`: `meta` plus the files it wrote
 * (`annotations/`-relative path and text), parsed the way opening the project
 * from disk would parse them.
 */
export function projectFromFiles(meta: unknown, files: Iterable<[string, string]>): Project {
  const papers = new Map<
    string,
    { consolidated?: unknown; reviewers: Map<string, unknown>; marksConsolidated?: unknown; reviewMarks: Map<string, unknown> }
  >()
  const screening = Boolean((meta as { config?: { screening?: unknown } } | null)?.config?.screening)
  const named = [...files].map(([relPath, text]) => {
    const slash = relPath.lastIndexOf('/')
    const name = relPath.slice(slash + 1)
    return { id: relPath.slice(0, slash), name, text, marks: parseMarksFileName(name, screening) }
  })
  // Old-style highlight files first, so a file under the kind's own name wins.
  named.sort((a, b) => Number(!a.marks?.legacy) - Number(!b.marks?.legacy))
  for (const { id, name, text, marks } of named) {
    let entry = papers.get(id)
    if (!entry) {
      entry = { reviewers: new Map(), reviewMarks: new Map() }
      papers.set(id, entry)
    }
    const value: unknown = JSON.parse(text)
    const reviewer = REVIEWER_FILE.exec(name)
    if (marks) {
      if (marks.seat === 'consolidated') entry.marksConsolidated = value
      else entry.reviewMarks.set(marks.seat, value)
    } else if (reviewer) entry.reviewers.set(reviewer[1], value)
    else entry.consolidated = value
  }
  return loadProject(assembleLegacyProjectJson(meta, papers))
}

/**
 * Reassemble a meta-only `project.json` plus its per-paper annotation files
 * into the legacy whole-project shape `loadProject` already parses — so the
 * read path reuses `loadProject`'s validation rather than duplicating it.
 * `paperFiles` holds each raw per-paper file, already `JSON.parse`d; a paper
 * with none on disk yet gets an empty entry.
 */
export function assembleLegacyProjectJson(
  meta: unknown,
  paperFiles: Map<
    string,
    {
      consolidated?: unknown
      reviewers: Map<string, unknown>
      marksConsolidated?: unknown
      reviewMarks: Map<string, unknown>
    }
  >,
): unknown {
  const m = meta as { papers?: unknown[] }
  const papers = Array.isArray(m.papers) ? m.papers : []
  return {
    ...(meta as object),
    papers: papers.map((p) => {
      if (typeof p !== 'object' || p === null || typeof (p as { id?: unknown }).id !== 'string') return p
      const id = (p as { id: string }).id
      const entry = paperFiles.get(id)
      const consolidated = (entry?.consolidated ?? {}) as {
        annotations?: unknown
        aiUsage?: unknown
        equal?: unknown
        alignment?: unknown
        consolidationSync?: unknown
        finished?: unknown
      }
      // Which schema version each file was written under, so the loader can
      // carry its answers across renames made since.
      const versionOf = (file: unknown) => (file as { schemaVersion?: unknown } | undefined)?.schemaVersion ?? null
      const schemaVersions: Record<string, unknown> = {}
      if (entry?.consolidated !== undefined) schemaVersions.consolidated = versionOf(entry.consolidated)
      if (entry?.marksConsolidated !== undefined) schemaVersions['marks-consolidated'] = versionOf(entry.marksConsolidated)
      for (const [k, v] of entry?.reviewers ?? []) schemaVersions[`review-${k}`] = versionOf(v)
      for (const [k, v] of entry?.reviewMarks ?? []) schemaVersions[`marks-${k}`] = versionOf(v)
      const reviews: Record<string, unknown> = {}
      const reviewsFinished: Record<string, unknown> = {}
      const reviewMetadata: Record<string, unknown> = {}
      const reviewsLock: Record<string, unknown> = {}
      for (const [k, v] of entry?.reviewers ?? []) {
        reviews[k] = (v as { annotations?: unknown })?.annotations ?? {}
        // Only lifted when actually declared — `loadProject` rejects anything
        // but literal `true` anyway.
        if ((v as { finished?: unknown })?.finished === true) reviewsFinished[k] = true
        const { metadataOverrides, metadataIgnored } = (v ?? {}) as { metadataOverrides?: unknown; metadataIgnored?: unknown }
        if (metadataOverrides !== undefined || metadataIgnored !== undefined) {
          reviewMetadata[k] = { overrides: metadataOverrides, ignored: metadataIgnored }
        }
        const { finishedAt, reopenedAt } = (v ?? {}) as { finishedAt?: unknown; reopenedAt?: unknown }
        if (finishedAt !== undefined || reopenedAt !== undefined) reviewsLock[k] = { finishedAt, reopenedAt }
      }
      const marksConsolidated = (entry?.marksConsolidated ?? {}) as { marks?: unknown }
      const reviewMarks: Record<string, unknown> = {}
      for (const [k, v] of entry?.reviewMarks ?? []) {
        reviewMarks[k] = (v as { marks?: unknown })?.marks ?? []
      }
      return {
        ...p,
        annotations: consolidated.annotations ?? {},
        ...(Object.keys(reviews).length > 0 ? { reviews } : {}),
        ...(consolidated.aiUsage !== undefined ? { aiUsage: consolidated.aiUsage } : {}),
        ...(consolidated.equal !== undefined ? { equal: consolidated.equal } : {}),
        ...(consolidated.alignment !== undefined ? { alignment: consolidated.alignment } : {}),
        ...(consolidated.consolidationSync !== undefined
          ? { consolidationSync: consolidated.consolidationSync }
          : {}),
        ...(marksConsolidated.marks !== undefined ? { marks: marksConsolidated.marks } : {}),
        ...(Object.keys(reviewMarks).length > 0 ? { reviewMarks } : {}),
        ...(consolidated.finished !== undefined ? { finished: consolidated.finished } : {}),
        ...(Object.keys(reviewsFinished).length > 0 ? { reviewsFinished } : {}),
        ...(Object.keys(reviewMetadata).length > 0 ? { reviewMetadata } : {}),
        ...(Object.keys(reviewsLock).length > 0 ? { reviewsLock } : {}),
        ...(Object.keys(schemaVersions).length > 0 ? { schemaVersions } : {}),
      }
    }),
  }
}

/** Plain string comparison on `id` — deterministic and independent of
 *  locale/collation settings, unlike title ordering (which also drifts if a
 *  reviewer ever edits a title after the file was first sorted). */
function comparePapers(a: Paper, b: Paper): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function extractExtra(obj: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k)) extra[k] = v
  }
  return extra
}

// [impl->req~dat-400~1]
/** Convert ResolvedDef back to the compact on-disk AnnotationDef shape. */
export function dehydrateSchema(defs: ResolvedDef[]): unknown[] {
  return defs.map((d) => {
    const out: Record<string, unknown> = { name: d.name }
    if (d.type !== undefined) out.type = d.type
    if (d.min !== 1) out.min = d.min
    if (d.max !== 1) out.max = d.max
    if (d.description !== undefined) out.description = d.description
    if (d.options !== undefined) out.options = d.options
    if (d.required) out.required = true
    if (d.visibleIf !== undefined) out.visibleIf = compactVisibleIf(d.visibleIf)
    if (d.unique) out.unique = true
    if (d.uniqueBy !== undefined) out.uniqueBy = d.uniqueBy
    if (d.children.length > 0) out.children = dehydrateSchema(d.children)
    return out
  })
}
