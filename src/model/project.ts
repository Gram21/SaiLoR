import { z } from 'zod'
import {
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
  type AnnotationValueTree,
} from './annotations'
import { screeningSchemaDefs } from '../screening/schema'
import { parseYear } from './year'
import { parseMarks, parseReviewMarks, type PdfMark } from './pdfMarks'

/**
 * One AI-assisted-annotation pass applied to a paper: which provider and model
 * produced it, and when. A permanent disclosure record, not a UI hint — unlike
 * the session-only "unconfirmed" marks (`aiMarks` in the store), this is meant
 * to survive into the saved file so a co-reviewer, or the reviewer themself
 * later, can see that (and how) AI was used on this paper. Append-only: each
 * `applyAiSuggestions` call that actually writes something adds one entry.
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
   * Publication year. `undefined`, not a sentinel, means "unknown" —
   * deliberately including the "in press" / "to appear" case: those describe
   * a publication *status*, not a year, and encoding a status into a numeric
   * field would make every consumer handle a value that is sometimes a
   * magnitude and sometimes a label. A venue-less preprint the author wants
   * to flag as forthcoming spells that in `venue` (free text) instead, e.g.
   * `"To appear in ICSE 2026"`.
   *
   * A number, not a string: every parser in `references.ts` already commits
   * to one (a regex match run through `Number`, or CSL's `date-parts[0][0]`),
   * so a string would force a redundant number→string conversion on import
   * and lose numeric sort/filter for no benefit.
   */
  year?: number
  /**
   * Where the paper appeared — journal, conference/proceedings, or publisher,
   * whichever the source called it. One free-text field, not separate
   * journal/proceedings fields: no source format (BibTeX journal/booktitle/
   * publisher, RIS JF/JO/T2, CSL container-title) reliably distinguishes
   * them, and a screener just needs to read "TSE" or "ICSE 2024".
   */
  venue?: string
  /**
   * The paper's abstract when the source had one. Screening is normally
   * decided on title + abstract, so this is the reading surface when there is
   * no PDF; it is ordinary paper metadata otherwise.
   */
  abstract?: string
  /**
   * True when `abstract` was produced by the PDF-text heuristic
   * (`extractPdfMeta` in `pdfMeta.ts`) rather than typed, imported from a
   * reference file, or otherwise authored. A durable disclosure, like
   * `aiUsage` — it must survive into the saved file so every reviewer who
   * opens this paper sees the same "unverified, proceed with caution" the
   * extracting session did, not just whoever happened to trigger it. Cleared
   * (never true) once a human or a reference-file import provides a real
   * abstract — see `fillFromRef` in `editorStore.ts`.
   */
  abstractFromPdf?: boolean
  pdf: string
  /** The single/consolidated result. Unchanged in meaning by multi-reviewer
   *  support: this is still what `validateProject`, `hasAnnotations`, and any
   *  future export read, and what a single-reviewer project uses exclusively. */
  annotations: AnnotationValueTree
  /**
   * Each independent reviewer's own annotations, keyed "1".."N" (a string
   * reviewer number, matching `Project.reviewers`). Absent/empty in a
   * single-reviewer project — `annotations` alone carries the data then, same
   * as before this feature existed.
   */
  reviews: Record<string, AnnotationValueTree>
  /**
   * AI-assisted annotation passes applied to this paper, oldest first — array
   * order alone establishes "the order of use", `appliedAt` makes it explicit
   * even if the array is ever hand-edited or reordered. Empty when AI has never
   * been used on this paper.
   */
  aiUsage: AiUsageRecord[]
  /**
   * Canonical field paths (`formatPath` form) where the consolidator has
   * declared the reviewers' differing answers to mean the same thing — e.g.
   * "RCT" and "randomized controlled trial". Empty until Consolidation marks
   * anything.
   *
   * One boolean per field, not per reviewer pair. Exact for two reviewers —
   * the common case, and the only shape a single mark can honestly describe —
   * but with three or more it cannot express "these two agree but that one
   * doesn't"; see `disagreements.ts`, which has to live with that limit.
   */
  equal: string[]
  /**
   * PDF highlights/comments — the single/consolidated reviewer's own marks in
   * a single-reviewer project, or the Consolidation seat's own reading marks
   * in a multi-reviewer one. Same "single tree vs. per-reviewer trees" split
   * `annotations`/`reviews` already has, and for the same reason: each
   * reviewer marks up their own reading independently. See `pdfMarks.ts`.
   */
  marks: PdfMark[]
  /** Each independent reviewer's own marks, keyed "1".."N" like `reviews`.
   *  Absent/empty in a single-reviewer project. */
  reviewMarks: Record<string, PdfMark[]>
  /** Any additional fields present in the source file are preserved on save. */
  extra: Record<string, unknown>
}

/**
 * The review's own protocol — its research questions, the search it ran, and
 * the criteria behind it — recorded *inside* the project file so a
 * pre-registered SLR's defining decisions travel with the data they produced,
 * rather than living in a separate document that drifts from it. Every field
 * is optional and authored by hand (unlike `ProjectProvenance`, which the app
 * writes on a screening import): a project that records none of this behaves
 * exactly as it did before this existed.
 *
 * A first-class field, not a `config` key, for a load-bearing reason: `config`
 * is a strict zod object rebuilt from scratch on every save (see
 * `serializeProject`), so anything hand-added under it — `config.protocol`,
 * `config.researchQuestions` — is *silently dropped* the first time the file
 * is saved. Root-level `extra` would survive, but a reviewer has no way to
 * know which of the two a stray key lands in. Making this an explicit,
 * parsed, round-tripped field is the only way the protocol is actually safe.
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
 * Where a project file's papers came from, when it was built by importing
 * from another project rather than started from scratch — recorded so a
 * shared, git-committed file can answer "where did this come from" (a PRISMA
 * flow diagram needs exactly this) without SaiLoR itself, and without either
 * source file still being reachable.
 */
export interface ProjectProvenance {
  /** Only one origin produces a project today; a discriminant keeps a second
   *  one (a reference-file import, say) additive rather than breaking. */
  kind: 'screening-import'
  source: {
    /** The source project's `title`, when it had one. */
    title?: string
    /** The source's file name at import time — never its path: these files
     *  are committed to git and shared, and an absolute path leaks the
     *  author's filesystem layout into every clone. */
    file: string
  }
  /** ISO 8601, the moment of import. */
  importedAt: string
  /**
   * The source's census at import time, and what actually landed here. A
   * snapshot, not a cache: screening continues in the source after the
   * import, and papers are added to and removed from this project, so
   * nothing here is derivable from either file later — which is exactly why
   * it is stored. `carried` is the number PRISMA's flow diagram wants.
   */
  counts: { included: number; undecided: number; excluded: number; carried: number }
}

export interface Project {
  version: number
  /** Display name for the review; empty when the file doesn't set one. */
  title?: string
  /** Set when this project's papers were imported from another project;
   *  null for a project started from scratch. Required (not optional) so
   *  that constructing a `Project` without deciding what to do with it is a
   *  type error, not a silent drop — see `mergeProjects`, which is exactly
   *  the place a silent `undefined` would lose it. */
  provenance: ProjectProvenance | null
  /** The review's authored protocol (research questions, search, criteria), or
   *  null when the file records none. Required (not optional) for the same
   *  reason `provenance` is: constructing a `Project` without deciding what to
   *  do with it should be a type error, not a silent drop in `mergeProjects`. */
  protocol: ProjectProtocol | null
  /** Free-text "about this schema" note — what the annotation fields mean as a
   *  whole, how to use them, anything a reviewer should read before starting —
   *  shown via an info button in the annotation panel, auto-opened once when a
   *  project that has one is loaded. Null when the file records none. Required
   *  (not optional) for the same reason `protocol` is. */
  schemaInfo: string | null
  schema: ResolvedDef[]
  /**
   * Whether AI-assisted annotation is available for this project. Defaults to
   * true; the provider of the file opts out with `config.ai: false`.
   */
  aiEnabled: boolean
  /**
   * Number of independent reviewers. 1 (the default; `config.reviewers`
   * absent or 1) means single-reviewer: every paper carries one
   * `annotations` tree and nobody picks a reviewer. More than 1 means each
   * reviewer 1..N annotates independently into `Paper.reviews[N]`, plus a
   * built-in Consolidation role that reconciles them into `Paper.annotations`.
   */
  reviewers: number
  papers: Paper[]
  /**
   * The screening configuration when this is a screening project, else null.
   * A screening project's `schema` is *derived* from this (see
   * `src/screening/schema.ts`) and whatever `config.schema` said in the file is
   * ignored — this is the single source of truth, and the schema written back
   * out is a projection of it, so the two can never drift.
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
  'marks',
  'reviewMarks',
])
/** Exported so `editorStore.ts`'s own root-extra split (`editorStateFromOpened`)
 *  uses this exact list rather than a second hand-maintained copy — see
 *  `deepEqualJson`'s doc comment for why a second implementation of "the same
 *  fact" is the bug this codebase specifically avoids. */
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
 * Parse `reviews` defensively, the same rule `annotations`/`aiUsage` follow:
 * the file is hand-editable, so a malformed entry is dropped, never thrown
 * over. A key is only kept when it looks like a reviewer number ("1", "2",
 * …) — anything else could never be reached by `currentTree`'s routing and
 * would just be dead weight riding along in the file. Each surviving tree is
 * normalized against the schema exactly like `annotations` is, so a reviewer
 * switching schemas mid-review still gets a well-formed tree to write into.
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
 * `parseReviews`, plus a skeleton for every reviewer `1..reviewerCount` who has
 * no tree of their own yet.
 *
 * A reviewer who has not started otherwise has no key in `reviews` at all —
 * fine for the app, which treats a missing tree as "hasn't answered" either
 * way, but bad for a JSON diff: their *first* annotation would then look like
 * a whole new field appearing out of nowhere, when every other reviewer's
 * equivalent field was there the whole time. A key that already exists with
 * `null`s in it turns that into an ordinary value-on-an-existing-line change —
 * the shape a git merge actually copes with.
 *
 * Never removes a key `parseReviews` already kept, including one for a
 * reviewer number *above* `reviewerCount` — lowering the count hides that
 * reviewer's tree, and this must not be the thing that deletes it (see the
 * schema guide's "Lowering the reviewer count" section).
 *
 * Single-reviewer projects are untouched: `reviews` stays `{}`, exactly as
 * before this existed — `annotations` alone carries the data there, and
 * giving it a phantom "reviewer 1" would only be confusing.
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
 * Parse `equal` defensively, the same rule `reviews`/`aiUsage` follow: the
 * file is hand-editable, so anything that isn't a string is dropped, never
 * thrown over. Deduped, since the mark is really a set — JSON just has no set
 * type to spell that with — and a hand-edited duplicate should not toggle
 * differently from a clean one.
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
 * a broken value here cannot be degraded past: the reasons *are* the schema's
 * enum, so a screening project with none of them has no way to record why
 * anything was excluded. Trimmed and deduped — the list is really a set, and
 * a duplicated option would render as a broken dropdown — but an empty result
 * is a load error, not an empty list.
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
 * Parse `provenance` defensively — the file is hand-editable, so a malformed
 * record is dropped, never thrown over. Unlike `parseScreening`, which throws
 * on a broken value: screening's reasons *are* the schema, so a broken list
 * cannot be degraded past, but provenance is inert documentation nothing in
 * the app reads back, so a broken one degrades to "no provenance" exactly
 * like `aiUsage`. The whole record is rejected if any piece fails — a
 * half-parsed provenance (a `counts` with one field missing, say) would be a
 * misleading one, not a merely incomplete one.
 *
 * Exported so `editorStore.ts`'s `editorStateFromOpened` shares this exact
 * parse rather than a second copy — the file it reads is the same shape, and
 * a screening-import draft's provenance must be judged by the identical rule
 * a plain `loadProject` would apply to the same bytes.
 */
/**
 * Parse `protocol` defensively — hand-editable, so a malformed record is
 * degraded, never thrown over (the same rule `parseProvenance` follows and for
 * the same reason: the app renders it but nothing downstream depends on its
 * shape). Unlike provenance, this is degraded *field by field* rather than
 * all-or-nothing: a reviewer's protocol is authored text, so a single
 * malformed key (a `databases` that is a string, say) should not throw away
 * the research questions next to it. A record that ends up entirely empty
 * after dropping bad fields parses to `null`, so an empty `{}` never survives
 * a round-trip as a stray key.
 *
 * Exported so `editorStore.ts` shares this exact parse rather than a second
 * copy — the same "one shared implementation" rule as `parseProvenance`.
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
 * Structural equality for plain JSON values: order-independent for object
 * keys (a hand-edited file listing fields in a different order than the
 * schema is not "different"), order-*sensitive* for arrays (an array is an
 * ordered list — reordering `Findings` genuinely changes which entry is
 * which), exactly JSON's own notion of equality otherwise. Deliberately not a
 * text/string comparison: `needsShapeMigration` uses this specifically so
 * that whitespace, indentation and stray key order — which even this file's
 * own `serializeProject` freely rewrites on every ordinary save — never look
 * like a reason to migrate a file that is already semantically fine.
 *
 * Exported for `src/git/merge.ts`, which needs the identical notion of
 * "structurally the same JSON value" to decide whether a field changed on a
 * side of a three-way merge — a second implementation of this would be a bug
 * waiting, the same reason `comparable()` in `src/consolidate/unanimous.ts`
 * exists as a single shared function rather than three copies.
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
 * Whether a project's `annotations`/`reviews` need the canonical serialized
 * shape written in — a hand-edited file, or one written by an older version
 * of the app.
 *
 * `rawText` is re-parsed and compared structurally (via `deepEqualJson`)
 * against what saving `project` right now *would* write, scoped to exactly
 * `annotations` and `reviews` — nothing else about the file's formatting or
 * unrelated content is examined, so this answers "does the annotation shape
 * need fixing", never "is this file byte-identical to our own pretty-printer".
 * That distinction is what keeps this from flagging every hand-authored or
 * differently-formatted file that already has the right shape.
 *
 * `rawText` is assumed to be exactly what `loadProject` just parsed
 * successfully to produce `project` — this only re-parses it, it does not
 * revalidate it, so call it right after `loadProject`, not independently.
 */
export function needsShapeMigration(project: Project, rawText: string): boolean {
  const data = JSON.parse(rawText) as { papers?: unknown[] }
  const rawPapers = Array.isArray(data.papers) ? data.papers : []
  return project.papers.some((paper, i) => {
    const rawPaper = (rawPapers[i] ?? {}) as Record<string, unknown>
    const rawAnnotations = rawPaper.annotations ?? {}
    if (!deepEqualJson(serializedTree(project.schema, paper.annotations), rawAnnotations)) return true
    if (project.reviewers <= 1) return false
    const canonicalReviews = Object.fromEntries(
      Object.entries(paper.reviews).map(([k, v]) => [k, serializedTree(project.schema, v)]),
    )
    const rawReviews = rawPaper.reviews ?? {}
    return !deepEqualJson(canonicalReviews, rawReviews)
  })
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

  // Depth first, before anything walks the data. Almost every traversal in the
  // app is recursive — zod's own validation, `resolveDefs`, `normalizeTree`,
  // `deepEqualJson`, `serializeProject` — and each blows the stack somewhere
  // between a few hundred and a few thousand levels. A ~29 KB file nested 704
  // deep made `projectSchema.parse` throw a raw `RangeError`, which escapes
  // this function's "throws ProjectLoadError with friendly details" contract
  // and lands in the store's generic fallback. Unknown keys are passed through
  // verbatim into `extra`, so depth there is unbounded too and surfaces later
  // in `deepEqualJson` — crashing the read-only git-status path, not just save.
  // One check at the entrance covers all of them.
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
    // Belt and braces: the depth guard above should make this unreachable, but
    // a stack overflow must never leave this function as anything other than a
    // ProjectLoadError.
    if (err instanceof RangeError) {
      throw new ProjectLoadError('The project file is nested too deeply.', [String(err)])
    }
    throw err
  }

  // A screening project's schema is not read from the file: it is derived from
  // `config.screening.reasons` every time, so a hand-edited reason list can
  // never disagree with the dropdown the reviewer actually sees. `serializeProject`
  // writes the derived schema back, which is what keeps the file self-describing
  // for anything reading it without SaiLoR. `raw.config.schema!` below is safe:
  // the zod `superRefine` guarantees it is present and non-empty whenever
  // `screening` is null.
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
    marks: parseMarks((p as { marks?: unknown }).marks),
    reviewMarks: parseReviewMarks((p as { reviewMarks?: unknown }).reviewMarks),
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
    // `ai` is only written when disabled, and `reviewers` only when it says
    // anything beyond the single-reviewer default — so a normal file, and a
    // single-reviewer file, both stay exactly as clean as before this feature.
    config: {
      // For a screening project this is the derived projection of
      // `config.screening.reasons`, not anything hand-authored — see
      // `Project.screening`. Written anyway so the file stays self-describing
      // for anything reading it without SaiLoR.
      schema: dehydrateSchema(project.schema),
      ...(project.aiEnabled ? {} : { ai: false }),
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
      // Only written alongside a real abstract, and only when true — so a
      // typed or reference-imported abstract stays exactly as clean as
      // before this field existed.
      if (p.abstractFromPdf && p.abstract) paper.abstractFromPdf = true
      paper.pdf = p.pdf
      paper.annotations = serializedTree(project.schema, p.annotations)
      // A single-reviewer paper has no reviewer trees at all — `annotations`
      // alone carries the data — so this stays empty and `reviews` is omitted
      // below, exactly as before this feature existed. A multi-reviewer paper's
      // `p.reviews` is never empty: `normalizeReviews` gives every reviewer
      // `1..N` a skeleton whether or not they have written anything, precisely
      // so the key is already there — on an existing line — the day they do.
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
      // Only written when non-empty, so a paper nobody has highlighted stays clean.
      if (p.marks.length > 0) paper.marks = p.marks
      const reviewMarkKeys = Object.keys(p.reviewMarks).filter((k) => p.reviewMarks[k].length > 0)
      if (reviewMarkKeys.length > 0) {
        paper.reviewMarks = Object.fromEntries(
          reviewMarkKeys.sort((a, b) => Number(a) - Number(b)).map((k) => [k, p.reviewMarks[k]]),
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
  return hasAnnotations(schema, tree) ? pruneTree(schema, tree) : {}
}

/**
 * On-disk layout: `project.json` (this file's `serializeProject` output) holds
 * only paper *metadata* — no `annotations`/`reviews`/`aiUsage`/`equal`. Those
 * live under a sibling `annotations/<paperId>/` folder, one JSON file per
 * reviewer plus one consolidated file for the `annotations` field (the
 * single/consolidated tree) and the paper-level `aiUsage`/`equal` records.
 * This is what lets two reviewers working on different papers, or the same
 * paper's different reviewer slots, never touch the same file — the merge
 * conflicts the split exists to avoid.
 *
 * A screening project's files are named `screening-<n>.json` /
 * `screening-consolidated.json` rather than `reviewer-<n>.json` /
 * `consolidated.json` — same layout, a different prefix purely so the two
 * kinds of per-paper decision (screening vs. full annotation) are
 * distinguishable at a glance in the folder, since a project can carry
 * screening history alongside an annotation schema (see `Project.screening`).
 *
 * `aiUsage`/`equal` are not split per-reviewer even in a multi-reviewer
 * project — `Paper.aiUsage` has always been one array for the whole paper,
 * not one per tree, and `equal` is inherently a consolidation-time concept.
 * Both are small, low-conflict-risk records, so they simply ride along in the
 * consolidated file regardless of which tree they actually describe.
 * ponytail: if AI usage disclosure ever needs to be attributed to a specific
 * reviewer's edit, give `Paper.aiUsage` entries a `reviewer` field first —
 * this file placement can stay as-is either way.
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

    if (project.reviewers > 1) {
      for (let k = 1; k <= project.reviewers; k++) {
        const tree = p.reviews[String(k)]
        const has = tree !== undefined && hasAnnotations(project.schema, tree)
        files.push({
          relPath: `${p.id}/${reviewerName}-${k}.json`,
          text: has ? JSON.stringify({ annotations: serializedTree(project.schema, tree) }, null, 2) : null,
        })
        const marks = p.reviewMarks[String(k)] ?? []
        files.push({
          relPath: `${p.id}/marks-${k}.json`,
          text: marks.length > 0 ? JSON.stringify({ marks }, null, 2) : null,
        })
      }
    }

    const consolidated: Record<string, unknown> = {}
    const hasConsolidatedAnnotations = hasAnnotations(project.schema, p.annotations)
    if (hasConsolidatedAnnotations) consolidated.annotations = serializedTree(project.schema, p.annotations)
    if (p.aiUsage.length > 0) consolidated.aiUsage = p.aiUsage
    if (p.equal.length > 0) consolidated.equal = p.equal
    files.push({
      relPath: `${p.id}/${consolidatedName}.json`,
      text: Object.keys(consolidated).length > 0 ? JSON.stringify(consolidated, null, 2) : null,
    })
    // Marks aren't screening/reviewer-decision data — they're reading notes,
    // and get their own file family regardless of screening vs. annotation
    // mode (unlike `reviewerName`/`consolidatedName` above, which distinguish
    // those two).
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
      ...(project.reviewers > 1 ? { reviewers: project.reviewers } : {}),
      ...(project.screening ? { screening: { reasons: project.screening.reasons } } : {}),
    },
    papers: metaPapers,
    ...project.extra,
  }
  return { meta, files }
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
 * Reassemble a meta-only `project.json` body plus its per-paper annotation
 * files back into the legacy whole-project shape `loadProject` already knows
 * how to parse — so the read path reuses `loadProject` unchanged rather than
 * duplicating its validation/defaulting logic. `paperFiles` holds each raw
 * per-paper file, already `JSON.parse`d, exactly as read from disk; a paper
 * with no files on disk yet (nobody has annotated it) simply gets an empty
 * entry.
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
      }
      const reviews: Record<string, unknown> = {}
      for (const [k, v] of entry?.reviewers ?? []) {
        reviews[k] = (v as { annotations?: unknown })?.annotations ?? {}
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
        ...(marksConsolidated.marks !== undefined ? { marks: marksConsolidated.marks } : {}),
        ...(Object.keys(reviewMarks).length > 0 ? { reviewMarks } : {}),
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
    if (d.children.length > 0) out.children = dehydrateSchema(d.children)
    return out
  })
}
