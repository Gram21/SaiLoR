import { z } from 'zod'

/**
 * The annotation schema is a nested taxonomy. Each node ("AnnotationDef") has a
 * display name and may be:
 *  - a leaf field (has a `type`: string | number | boolean),
 *  - a group (has `children` but no `type`, i.e. a name-only sub-tree),
 *  - or both (a field that also owns a sub-tree).
 *
 * Cardinality is expressed with `min` (default 1) and `max` (default 1;
 * `null` means unbounded). It applies to group nodes too, allowing several
 * parallel sub-trees.
 */

export type FieldType = 'string' | 'number' | 'boolean'

export interface AnnotationDef {
  name: string
  type?: FieldType
  min?: number
  /** A positive integer, or `null` for unbounded. Defaults to 1. */
  max?: number | null
  description?: string
  /** For a `string` field: a fixed set of allowed values (enum), shown as a dropdown. */
  options?: string[]
  /** The reviewer must fill this field in. Defaults to false. */
  required?: boolean
  children?: AnnotationDef[]
}

/** Same as {@link AnnotationDef} but with defaults resolved and an id assigned. */
export interface ResolvedDef {
  /** Stable id derived from the node's path (slash-joined sibling names). */
  id: string
  name: string
  type?: FieldType
  min: number
  /** null = unbounded */
  max: number | null
  description?: string
  /** Enum values for a `string` field (renders as a filterable dropdown). */
  options?: string[]
  required: boolean
  children: ResolvedDef[]
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const fieldTypeSchema = z.enum(['string', 'number', 'boolean'])

// zod has no native recursion helper for input inference, so we type it lazily.
export const annotationDefSchema: z.ZodType<AnnotationDef> = z.lazy(() =>
  z
    .object({
      name: z.string().min(1, 'Annotation "name" must be a non-empty string'),
      type: fieldTypeSchema.optional(),
      min: z.number().int().min(0).optional(),
      max: z.union([z.number().int().min(1), z.null()]).optional(),
      description: z.string().optional(),
      options: z.array(z.string()).optional(),
      required: z.boolean().optional(),
      children: z.array(annotationDefSchema).optional(),
    })
    .strict()
    .superRefine((def, ctx) => {
      const min = def.min ?? 1
      const max = def.max === undefined ? 1 : def.max
      if (max !== null && max < min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${def.name}": max (${max}) must be >= min (${min})`,
        })
      }
      if (!def.type && (!def.children || def.children.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${def.name}": a node must have a "type" or non-empty "children"`,
        })
      }
      if (def.options && def.options.length > 0 && def.type !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${def.name}": "options" (enum) is only allowed on a string field (set "type": "string")`,
        })
      }
      if (def.required && !def.type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${def.name}": "required" is only allowed on a field (set a "type")`,
        })
      }
    }),
)

export const paperSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    authors: z.array(z.string()).default([]),
    doi: z.string().optional(),
    /** The paper's abstract, when the source had one. Screening reads this when
     *  there is no PDF — see `Project.screening`. */
    abstract: z.string().optional(),
    /** True when `abstract` was produced by the PDF-text heuristic in
     *  `pdfMeta.ts` rather than authored, imported from a reference file, or
     *  typed — see `Paper.abstractFromPdf`. Meaningless (and dropped) without
     *  a non-empty `abstract`, so left loosely typed here; normalized structurally
     *  in `project.ts`, same rule as `annotations`/`reviews`. */
    abstractFromPdf: z.boolean().optional(),
    // The "pdf required" rule moves to `projectSchema`'s `superRefine`, which
    // can see whether this is a screening project (where PDFs are usually
    // absent entirely — see `src/screening/schema.ts`).
    pdf: z.string().default(''),
    // Loosely typed here; validated/normalized structurally in project.ts.
    annotations: z.record(z.unknown()).optional(),
    // Ditto — a malformed entry (or the whole field being the wrong shape)
    // should be dropped, not fail the whole file to load.
    aiUsage: z.unknown().optional(),
    // Ditto — each reviewer's tree is validated/normalized structurally in
    // project.ts, same as `annotations`.
    reviews: z.unknown().optional(),
    // Ditto — a list of canonical field paths, deduped and validated
    // structurally in project.ts, same as `reviews`.
    equal: z.unknown().optional(),
  })
  .passthrough()

/**
 * A screening project's one authorable setting: the exclusion reasons, fixed up
 * front the way a pre-registered SLR protocol fixes them. `config.screening`'s
 * presence is what makes a project a screening project; its `reasons` are the
 * only thing about the schema an author chooses, since the rest of it is derived
 * (see `src/screening/schema.ts`).
 */
export interface ScreeningConfig {
  /** Non-empty, trimmed, deduped by `project.ts`. Order is the order reported. */
  reasons: string[]
}

const screeningConfigSchema: z.ZodType<ScreeningConfig> = z
  .object({
    reasons: z
      .array(z.string())
      .min(1, 'config.screening.reasons must list at least one exclusion reason'),
  })
  .strict()

export const projectSchema = z
  .object({
    version: z.number().optional(),
    /** Human-readable name for the review; falls back to the file name when absent. */
    title: z.string().optional(),
    // Loosely typed here; validated/normalized structurally in project.ts —
    // the same rule `aiUsage`/`reviews`/`equal` follow on `paperSchema`.
    provenance: z.unknown().optional(),
    config: z.object({
      // Optional-and-unbounded here: a screening project's schema is derived,
      // not authored (see `screeningConfigSchema` above), so it may be absent
      // from the file entirely. Every other project still needs a real one —
      // enforced below, in `superRefine`, where the presence of `screening`
      // can be taken into account.
      schema: z.array(annotationDefSchema).optional(),
      /** When false, the provider of this file has disabled AI-assisted annotation. */
      ai: z.boolean().optional(),
      /** Number of independent reviewers. Absent or 1 = single-reviewer (the default). */
      reviewers: z.number().int().min(1).max(10).optional(),
      screening: screeningConfigSchema.optional(),
    }),
    papers: z.array(paperSchema),
  })
  .passthrough()
  .superRefine((raw, ctx) => {
    // A screening project's schema is derived, not authored — see
    // `src/screening/schema.ts`. Everyone else still must supply one.
    if (!raw.config.screening && (!raw.config.schema || raw.config.schema.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'schema'],
        message: 'config.schema must have at least one node',
      })
    }
    // Screening is normally done on title + abstract, from a reference-manager
    // export that has no PDFs at all. Requiring one there would rule out the
    // whole workflow; requiring one everywhere else is unchanged.
    if (!raw.config.screening) {
      raw.papers.forEach((p, i) => {
        if (!p.pdf) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['papers', i, 'pdf'],
            message: 'Each paper needs a "pdf" path',
          })
        }
      })
    }
  })

export type RawProject = z.infer<typeof projectSchema>
export type RawPaper = z.infer<typeof paperSchema>

// ---------------------------------------------------------------------------
// Resolution: apply defaults, assign ids, enforce sibling-name uniqueness
// ---------------------------------------------------------------------------

export class SchemaError extends Error {}

function resolveDefs(defs: AnnotationDef[], parentPath: string): ResolvedDef[] {
  const seen = new Set<string>()
  return defs.map((def) => {
    if (seen.has(def.name)) {
      throw new SchemaError(
        `Duplicate sibling annotation name "${def.name}"${
          parentPath ? ` under "${parentPath}"` : ' at the top level'
        }. Sibling names must be unique.`,
      )
    }
    seen.add(def.name)

    const id = parentPath ? `${parentPath}/${def.name}` : def.name
    const min = def.min ?? 1
    const max = def.max === undefined ? 1 : def.max
    return {
      id,
      name: def.name,
      type: def.type,
      min,
      max,
      description: def.description,
      options: def.options,
      required: def.required ?? false,
      children: def.children ? resolveDefs(def.children, id) : [],
    }
  })
}

/** Validate + resolve a raw schema array into ResolvedDef nodes. */
export function resolveSchema(defs: AnnotationDef[]): ResolvedDef[] {
  return resolveDefs(defs, '')
}

/** True if a node can occur more than once. */
export function isRepeatable(def: ResolvedDef): boolean {
  return def.max === null || def.max > 1
}

/** True if a node carries an editable value field. */
export function isField(def: ResolvedDef): boolean {
  return def.type !== undefined
}
