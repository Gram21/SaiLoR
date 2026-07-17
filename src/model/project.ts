import { z } from 'zod'
import {
  projectSchema,
  resolveSchema,
  SchemaError,
  type ResolvedDef,
  type ScreeningConfig,
} from './schema'
import {
  normalizeTree,
  pruneTree,
  type AnnotationValueTree,
} from './annotations'
import { screeningSchemaDefs } from '../screening/schema'
import {
  parseReviewerIdentities,
  serializeReviewerIdentities,
  type ReviewerIdentity,
} from './identity'

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
  /** Any additional fields present in the source file are preserved on save. */
  extra: Record<string, unknown>
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
  /** Who holds each seat, keyed the way `reviews` is ("1".."N") plus
   *  "consolidation". Empty for every file written before this existed, and for
   *  every project nobody has claimed a seat in — which must keep behaving
   *  exactly as it did then. Absent, never a skeleton: unlike `reviews` (see
   *  `normalizeReviews`), an unclaimed seat has no diff-friendliness to buy —
   *  a claim is a rare, deliberate act, and a key appearing in the diff is
   *  precisely what it looks like. See `src/model/identity.ts` for the hazard
   *  this exists to catch and why the comparison key is email, not name. */
  reviewerIdentities: Record<string, ReviewerIdentity>
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
  'abstract',
  'abstractFromPdf',
  'pdf',
  'annotations',
  'reviews',
  'aiUsage',
  'equal',
])
/** Exported so `editorStore.ts`'s own root-extra split (`editorStateFromOpened`)
 *  uses this exact list rather than a second hand-maintained copy — see
 *  `deepEqualJson`'s doc comment for why a second implementation of "the same
 *  fact" is the bug this codebase specifically avoids. */
export const KNOWN_ROOT_KEYS = new Set(['version', 'title', 'provenance', 'config', 'papers'])

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
 * Whether a project's `annotations`/`reviews` need the git-friendly empty
 * skeleton written in — a brand-new paper saved before this existed, an
 * untouched reviewer with no key at all, a hand-edited file, or one written by
 * an older version of the app.
 *
 * `rawText` is re-parsed and compared structurally (via `deepEqualJson`)
 * against what saving `project` right now *would* write, scoped to exactly
 * `annotations` and `reviews` — nothing else about the file's formatting or
 * unrelated content is examined, so this answers "does the skeleton need
 * fixing", never "is this file byte-identical to our own pretty-printer".
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
    if (!deepEqualJson(pruneTree(project.schema, paper.annotations), rawAnnotations)) return true
    if (project.reviewers <= 1) return false
    const canonicalReviews = Object.fromEntries(
      Object.entries(paper.reviews).map(([k, v]) => [k, pruneTree(project.schema, v)]),
    )
    const rawReviews = rawPaper.reviews ?? {}
    return !deepEqualJson(canonicalReviews, rawReviews)
  })
}

/**
 * Parse raw JSON text (or an already-parsed object) into a validated,
 * normalized Project. Throws {@link ProjectLoadError} with friendly details.
 */
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
    extra: extractExtra(p, KNOWN_PAPER_KEYS),
  }))

  return {
    version: raw.version ?? 1,
    title: raw.title,
    provenance: parseProvenance(raw.provenance),
    schema,
    // Absent means enabled; only an explicit `false` opts out.
    aiEnabled: raw.config.ai !== false,
    // Absent or 1 means single-reviewer; zod already bounds a present value to [1, 10].
    reviewers: raw.config.reviewers ?? 1,
    reviewerIdentities: parseReviewerIdentities(
      (raw.config as { reviewerIdentities?: unknown }).reviewerIdentities,
    ),
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
    ...project.extra,
    version: project.version,
    ...(project.title ? { title: project.title } : {}),
    // Only written when this project was actually imported from another —
    // an ordinary project stays exactly as clean as before this field existed.
    ...(project.provenance ? { provenance: project.provenance } : {}),
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
      // Grouped with `reviewers`, which it annotates. Only emitted when
      // non-empty, so every project nobody has claimed a seat in — which is
      // every file written before this existed — stays byte-identical.
      ...(() => {
        const ids = serializeReviewerIdentities(project.reviewerIdentities)
        return ids ? { reviewerIdentities: ids } : {}
      })(),
      ...(project.screening ? { screening: { reasons: project.screening.reasons } } : {}),
    },
    papers: project.papers.map((p) => {
      const paper: Record<string, unknown> = {
        ...p.extra,
        id: p.id,
        title: p.title,
        authors: p.authors,
      }
      if (p.doi !== undefined) paper.doi = p.doi
      if (p.abstract !== undefined && p.abstract !== '') paper.abstract = p.abstract
      // Only written alongside a real abstract, and only when true — so a
      // typed or reference-imported abstract stays exactly as clean as
      // before this field existed.
      if (p.abstractFromPdf && p.abstract) paper.abstractFromPdf = true
      paper.pdf = p.pdf
      paper.annotations = pruneTree(project.schema, p.annotations)
      // A single-reviewer paper has no reviewer trees at all — `annotations`
      // alone carries the data — so this stays empty and `reviews` is omitted
      // below, exactly as before this feature existed. A multi-reviewer paper's
      // `p.reviews` is never empty: `normalizeReviews` gives every reviewer
      // `1..N` a skeleton whether or not they have written anything, precisely
      // so the key is already there — on an existing line — the day they do.
      const reviewKeys = Object.keys(p.reviews)
      if (reviewKeys.length > 0) {
        paper.reviews = Object.fromEntries(
          reviewKeys.map((k) => [k, pruneTree(project.schema, p.reviews[k])]),
        )
      }
      // Only written when non-empty, so a paper AI has never touched stays clean.
      if (p.aiUsage.length > 0) paper.aiUsage = p.aiUsage
      // Only written when non-empty, so a paper with no equality marks stays clean.
      if (p.equal.length > 0) paper.equal = p.equal
      return paper
    }),
  }
  return JSON.stringify(out, null, 2)
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
