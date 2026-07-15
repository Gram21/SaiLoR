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
  annotations: AnnotationValueTree
  /**
   * AI-assisted annotation passes applied to this paper, oldest first — array
   * order alone establishes "the order of use", `appliedAt` makes it explicit
   * even if the array is ever hand-edited or reordered. Empty when AI has never
   * been used on this paper.
   */
  aiUsage: AiUsageRecord[]
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

const KNOWN_PAPER_KEYS = new Set(['id', 'title', 'authors', 'doi', 'pdf', 'annotations', 'aiUsage'])
const KNOWN_ROOT_KEYS = new Set(['version', 'title', 'config', 'papers'])

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
    aiUsage: parseAiUsage(p.aiUsage),
    extra: extractExtra(p, KNOWN_PAPER_KEYS),
  }))

  return {
    version: raw.version ?? 1,
    title: raw.title,
    schema,
    // Absent means enabled; only an explicit `false` opts out.
    aiEnabled: raw.config.ai !== false,
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
    // `ai` is only written when disabled, so a normal file stays clean.
    config: {
      schema: dehydrateSchema(project.schema),
      ...(project.aiEnabled ? {} : { ai: false }),
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
      // Only written when non-empty, so a paper AI has never touched stays clean.
      if (p.aiUsage.length > 0) paper.aiUsage = p.aiUsage
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
