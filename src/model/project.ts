import { z } from 'zod'
import {
  projectSchema,
  resolveSchema,
  SchemaError,
  type ResolvedDef,
} from './schema'
import {
  normalizeTree,
  pruneTree,
  type AnnotationValueTree,
} from './annotations'

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

export interface Project {
  version: number
  /** Display name for the review; empty when the file doesn't set one. */
  title?: string
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
  'pdf',
  'annotations',
  'reviews',
  'aiUsage',
  'equal',
])
const KNOWN_ROOT_KEYS = new Set(['version', 'title', 'config', 'papers'])

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

  let schema: ResolvedDef[]
  try {
    schema = resolveSchema(raw.config.schema)
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
    pdf: p.pdf,
    annotations: normalizeTree(schema, p.annotations as AnnotationValueTree | undefined),
    reviews: parseReviews((p as { reviews?: unknown }).reviews, schema),
    aiUsage: parseAiUsage(p.aiUsage),
    equal: parseEqual(p.equal),
    extra: extractExtra(p, KNOWN_PAPER_KEYS),
  }))

  return {
    version: raw.version ?? 1,
    title: raw.title,
    schema,
    // Absent means enabled; only an explicit `false` opts out.
    aiEnabled: raw.config.ai !== false,
    // Absent or 1 means single-reviewer; zod already bounds a present value to [1, 10].
    reviewers: raw.config.reviewers ?? 1,
    papers,
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
    // `ai` is only written when disabled, and `reviewers` only when it says
    // anything beyond the single-reviewer default — so a normal file, and a
    // single-reviewer file, both stay exactly as clean as before this feature.
    config: {
      schema: dehydrateSchema(project.schema),
      ...(project.aiEnabled ? {} : { ai: false }),
      ...(project.reviewers > 1 ? { reviewers: project.reviewers } : {}),
    },
    papers: project.papers.map((p) => {
      const paper: Record<string, unknown> = {
        ...p.extra,
        id: p.id,
        title: p.title,
        authors: p.authors,
      }
      if (p.doi !== undefined) paper.doi = p.doi
      paper.pdf = p.pdf
      paper.annotations = pruneTree(project.schema, p.annotations)
      // Only written when non-empty, so a single-reviewer paper (or one no
      // reviewer has touched yet) carries no `reviews` key at all.
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
