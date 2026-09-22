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
import { parseYear } from './year'
import { parseMarks, parseReviewMarks, type PdfMark } from './pdfMarks'
import { parseAlignment, type StoredAlignment } from './alignment'

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
}

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
  /** Any additional fields present in the source file are preserved on save. */
  extra: Record<string, unknown>
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
  /** Whether AI-assisted annotation is available. Defaults to true; opt out
   *  with `config.ai: false`. */
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
])
/** Exported so `editorStore.ts`'s root-extra split reuses this exact list
 *  rather than a second hand-maintained copy. */
export const KNOWN_ROOT_KEYS = new Set([
  'version',
  'title',
  'provenance',
  'protocol',
  'schemaInfo',
  'config',
  'papers',
])

/**
 * Parse `reviews` defensively: the file is hand-editable, so a malformed entry
 * is dropped, never thrown over. Only keys that look like a reviewer number
 * are kept — anything else is unreachable dead weight.
 */
function parseReviews(raw: unknown, schema: ResolvedDef[]): Record<string, AnnotationValueTree> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
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

/**
 * Parse `aiUsage` defensively: the file is hand-editable, so a malformed entry
 * must be dropped, never thrown over — the same rule `annotations` follows.
 */
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
      const e = entry as Record<string, string>
      out.push({ provider: e.provider, model: e.model, appliedAt: e.appliedAt })
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
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    reasons.push(trimmed)
  }
  if (reasons.length === 0) {
    throw new ProjectLoadError('The screening configuration is invalid.', [
      'config.screening.reasons must list at least one exclusion reason',
    ])
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

export function loadProject(input: string | unknown): Project {
  let data: unknown
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input)
    } catch (err) {
      throw new ProjectLoadError('The file is not valid JSON.', [String(err)])
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
    throw new ProjectLoadError('The project file is nested too deeply.', [
      `Nesting deeper than ${MAX_JSON_DEPTH} levels is not supported.`,
    ])
  }

  let raw
  try {
    raw = projectSchema.parse(data)
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new ProjectLoadError(
        'The project file does not match the expected structure.',
        err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      )
    }
    // Belt and braces: depth guard above should make this unreachable, but a
    // stack overflow must never escape as anything but ProjectLoadError.
    if (err instanceof RangeError) {
      throw new ProjectLoadError('The project file is nested too deeply.', [String(err)])
    }
    throw err
  }

  // A screening project's schema is derived from `config.screening.reasons`
  // every load, never read from the file, so a hand-edited reason list can't
  // disagree with the dropdown shown. `raw.config.schema!` is safe: zod's
  // `superRefine` guarantees it's present whenever `screening` is null.
  const screening = parseScreening((raw.config as { screening?: unknown }).screening)
  let schema: ResolvedDef[]
  try {
    schema = resolveSchema(screening ? screeningSchemaDefs(screening) : raw.config.schema!)
  } catch (err) {
    if (err instanceof SchemaError) {
      throw new ProjectLoadError('The annotation schema is invalid.', [err.message])
    }
    throw err
  }

  // Duplicate paper ids would break selection/navigation.
  const ids = new Set<string>()
  for (const p of raw.papers) {
    if (ids.has(p.id)) {
      throw new ProjectLoadError('Duplicate paper id.', [`Paper id "${p.id}" appears more than once.`])
    }
    ids.add(p.id)
  }

  const papers: Paper[] = raw.papers.map((p) => ({
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
    annotations: normalizeTree(schema, p.annotations as AnnotationValueTree | undefined),
    reviews: normalizeReviews((p as { reviews?: unknown }).reviews, schema, raw.config.reviewers ?? 1),
    aiUsage: parseAiUsage(p.aiUsage),
    equal: parseEqual(p.equal),
    alignment: parseAlignment((p as { alignment?: unknown }).alignment),
    consolidationSync:
      typeof (p as { consolidationSync?: unknown }).consolidationSync === 'string'
        ? ((p as { consolidationSync?: string }).consolidationSync as string)
        : undefined,
    marks: parseMarks((p as { marks?: unknown }).marks),
    reviewMarks: parseReviewMarks((p as { reviewMarks?: unknown }).reviewMarks),
    // Only a literal `true` declares anything — see `parseReviewsFinished`.
    finished: (p as { finished?: unknown }).finished === true,
    reviewsFinished: parseReviewsFinished((p as { reviewsFinished?: unknown }).reviewsFinished),
    extra: extractExtra(p, KNOWN_PAPER_KEYS),
  }))

  return {
    version: raw.version ?? 1,
    title: raw.title,
    provenance: parseProvenance(raw.provenance),
    protocol: parseProtocol(raw.protocol),
    schemaInfo: parseSchemaInfo(raw.schemaInfo),
    schema,
    // Absent means enabled; only an explicit `false` opts out.
    aiEnabled: raw.config.ai !== false,
    // Absent means enabled, same rule as `ai` above; only an explicit `false`
    // opts out, so a file predating this option behaves exactly as before.
    finishCheckbox: (raw.config as { finishCheckbox?: unknown }).finishCheckbox !== false,
    // Absent or 1 means single-reviewer; zod already bounds a present value to [1, 10].
    reviewers: raw.config.reviewers ?? 1,
    papers,
    screening,
    extra: extractExtra(raw, KNOWN_ROOT_KEYS),
  }
}

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
    // `ai`/`reviewers` are only written when they differ from the default, so
    // an ordinary or single-reviewer file stays exactly as clean as before.
    config: {
      // Derived projection of `config.screening.reasons` for a screening
      // project (see `Project.screening`), written so the file stays
      // self-describing.
      schema: dehydrateSchema(project.schema),
      ...(project.aiEnabled ? {} : { ai: false }),
      ...(project.finishCheckbox ? {} : { finishCheckbox: false }),
      ...(project.reviewers > 1 ? { reviewers: project.reviewers } : {}),
      ...(project.screening ? { screening: { reasons: project.screening.reasons } } : {}),
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

/**
 * Split a `Project` into the meta-only `project.json` body and the set of
 * per-paper annotation files it should reconcile on disk. Pure and
 * side-effect-free — `electron/main.ts` does the actual fs writes/deletes, so
 * this stays unit-testable without touching a filesystem.
 */
export function splitProjectFiles(project: Project): { meta: unknown; files: ProjectFileEntry[] } {
  const files: ProjectFileEntry[] = []
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
    if (reviewerSlots.size > 0) {
      for (const k of [...reviewerSlots].sort((a, b) => a - b)) {
        const tree = p.reviews[String(k)]
        const has = tree !== undefined && hasContent(project.schema, tree)
        // Rides in the same per-reviewer file as that reviewer's tree, so it
        // never collides with another reviewer's save; it can also keep the
        // file alive alone — ticking the box then clearing a field still said
        // something, and dropping the file would un-say it.
        const finished = p.reviewsFinished[String(k)] === true
        files.push({
          relPath: `${p.id}/${reviewerName}-${k}.json`,
          text:
            has || finished
              ? JSON.stringify(
                  {
                    ...(has ? { annotations: serializedTree(project.schema, tree!) } : {}),
                    ...(finished ? { finished: true } : {}),
                  },
                  null,
                  2,
                )
              : null,
        })
        const marks = p.reviewMarks[String(k)] ?? []
        files.push({
          relPath: `${p.id}/marks-${k}.json`,
          text: marks.length > 0 ? JSON.stringify({ marks }, null, 2) : null,
        })
      }
    }

    const consolidated: Record<string, unknown> = {}
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
      text: Object.keys(consolidated).length > 0 ? JSON.stringify(consolidated, null, 2) : null,
    })
    // Marks are reading notes, not screening/reviewer decisions, so they get
    // their own file family regardless of screening vs. annotation mode.
    files.push({
      relPath: `${p.id}/marks-consolidated.json`,
      text: p.marks.length > 0 ? JSON.stringify({ marks: p.marks }, null, 2) : null,
    })

    return { ...paper, ...p.extra }
  })

  const meta = {
    version: project.version,
    ...(project.title ? { title: project.title } : {}),
    ...(project.provenance ? { provenance: project.provenance } : {}),
    ...(project.protocol ? { protocol: project.protocol } : {}),
    ...(project.schemaInfo ? { schemaInfo: project.schemaInfo } : {}),
    config: {
      schema: dehydrateSchema(project.schema),
      ...(project.aiEnabled ? {} : { ai: false }),
      ...(project.finishCheckbox ? {} : { finishCheckbox: false }),
      ...(project.reviewers > 1 ? { reviewers: project.reviewers } : {}),
      ...(project.screening ? { screening: { reasons: project.screening.reasons } } : {}),
    },
    papers: metaPapers,
    ...project.extra,
  }
  return { meta, files }
}

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
      const reviews: Record<string, unknown> = {}
      const reviewsFinished: Record<string, unknown> = {}
      for (const [k, v] of entry?.reviewers ?? []) {
        reviews[k] = (v as { annotations?: unknown })?.annotations ?? {}
        // Only lifted when actually declared — `loadProject` rejects anything
        // but literal `true` anyway.
        if ((v as { finished?: unknown })?.finished === true) reviewsFinished[k] = true
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
    if (d.children.length > 0) out.children = dehydrateSchema(d.children)
    return out
  })
}
