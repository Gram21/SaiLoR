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
    pdf: z.string().min(1, 'Each paper needs a "pdf" path'),
    // Loosely typed here; validated/normalized structurally in project.ts.
    annotations: z.record(z.unknown()).optional(),
    // Ditto — a malformed entry (or the whole field being the wrong shape)
    // should be dropped, not fail the whole file to load.
    aiUsage: z.unknown().optional(),
  })
  .passthrough()

export const projectSchema = z
  .object({
    version: z.number().optional(),
    /** Human-readable name for the review; falls back to the file name when absent. */
    title: z.string().optional(),
    config: z.object({
      schema: z.array(annotationDefSchema).min(1, 'config.schema must have at least one node'),
      /** When false, the provider of this file has disabled AI-assisted annotation. */
      ai: z.boolean().optional(),
    }),
    papers: z.array(paperSchema),
  })
  .passthrough()

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
