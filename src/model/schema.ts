import { z } from 'zod'

/**
 * The annotation schema is a nested taxonomy. Each node ("AnnotationDef") has a
 * display name and may be:
 *  - a leaf field (has a `type`: string | number | boolean | year),
 *  - a group (has `children` but no `type`, i.e. a name-only sub-tree),
 *  - or both (a field that also owns a sub-tree).
 *
 * Cardinality is expressed with `min` (default 1) and `max` (default 1;
 * `null` means unbounded). It applies to group nodes too, allowing several
 * parallel sub-trees.
 */

/**
 * `year` rides the same on-disk shape as `number` (a JSON number) — it is not
 * a new value shape, only a bounded, purpose-named one, so it needs no new
 * member on `FieldValue` and no changes to `annotations.ts`'s tree machinery.
 * What it buys over a plain `number` is real validation (`YEAR_MIN`..`YEAR_MAX`
 * in `model/year.ts`) and a control that reads as "a year" rather than an
 * unconstrained number — see `docs/annotation-schema.md` §3.1 for why a full
 * `date` type was rejected as the wrong size for what an SLR actually needs.
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'year'

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

const fieldTypeSchema = z.enum(['string', 'number', 'boolean', 'year'])

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
    /**
     * Publication year. `"year": "2021"` is a very plausible hand-edit, and a
     * file containing it loads today (via `.passthrough()` into `extra`), so
     * tightening this to `z.number().optional()` would break a file that
     * currently opens fine. Loosely typed here for the same reason
     * `annotations`/`reviews` are: repaired-or-dropped structurally in
     * `project.ts` (`parseYear`), not enforced at the zod layer.
     */
    year: z.unknown().optional(),
    /** Journal, conference/proceedings, or publisher — whichever the source
     *  called "where this appeared". One free-text field rather than
     *  separate journal/proceedings fields: no import format (BibTeX
     *  journal/booktitle/publisher, RIS JF/JO/T2, CSL container-title)
     *  reliably distinguishes them, and a screener just needs to read
     *  "TSE" or "ICSE 2024". */
    venue: z.string().optional(),
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
    // Root-level, not under `config`, precisely so it survives a save — see
    // `ProjectProtocol`'s doc comment. Loosely typed, parsed in `parseProtocol`.
    protocol: z.unknown().optional(),
    // Same reasoning as `protocol` above — root-level so it survives a save,
    // loosely typed here and parsed in `parseSchemaInfo`.
    schemaInfo: z.unknown().optional(),
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
    // Deliberately NOT trimmed. `normalizeTree` looks answers up by the
    // resolved def name, so renaming `"Claim "` to `"Claim"` on load makes the
    // lookup miss the stored `"Claim "` key and replaces a real answer with an
    // empty instance, which the next save then makes permanent — silent data
    // loss on open, for a file that previously worked.
    //
    // An earlier version of this comment claimed the padding affected only path
    // resolution and put no answer at risk. That was wrong, and the correction
    // is worth keeping: a canonical segment *is* trimmed by `parsePath`, so with
    // two siblings named `"Claim"` and `"Claim "` the padded one's canonical
    // resolved to the *other* def — and `git/changes.ts` writes through
    // `container[resolved.name]`, so a committed answer landed in the wrong
    // field. That ambiguity is now refused below, where it can still be caught;
    // a *lone* padded name is fine and resolves through a trimmed fallback in
    // `resolvePath`.
    // Annotation trees are plain objects keyed by field name, so a field called
    // `__proto__` would hit `Object.prototype`'s setter instead of creating an
    // own property: the field reads and edits normally (values come back
    // through the prototype) but `Object.keys` skips it and `JSON.stringify`
    // drops it, so a reviewer's answers for it vanish on save with no error.
    // Rejected rather than silently renamed — this can only come from a
    // hand-edited file, and quietly changing someone's schema is worse.
    if (def.name === '__proto__') {
      throw new SchemaError(
        `Annotation name "__proto__" is not allowed${
          parentPath ? ` (under "${parentPath}")` : ''
        }: answers stored under it cannot be saved. Rename the field.`,
      )
    }
    if (seen.has(def.name)) {
      throw new SchemaError(
        `Duplicate sibling annotation name "${def.name}"${
          parentPath ? ` under "${parentPath}"` : ' at the top level'
        }. Sibling names must be unique.`,
      )
    }
    // Siblings that differ only by surrounding whitespace are rejected too,
    // because the canonical path format cannot tell them apart. `parsePath`
    // trims a segment (so "Findings [1]" reads as "Findings"), which means the
    // canonical for "Claim " resolves to the def named "Claim" — and
    // `git/changes.ts` writes with `container[resolved.name]`, so a reviewer's
    // committed answer would land in the *other* field. Refusing the schema is
    // the only place that ambiguity can be caught: once both names exist, no
    // path can name one of them unambiguously.
    const clash = [...seen].find((n) => n.trim() === def.name.trim())
    if (clash !== undefined) {
      throw new SchemaError(
        `Annotation names "${clash}" and "${def.name}"${
          parentPath ? ` under "${parentPath}"` : ' at the top level'
        } differ only by surrounding spaces, which makes answers to them
 indistinguishable. Rename one of them.`.replace(/\s*\n\s*/g, ' '),
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
      // Dropped for a boolean, silently: a checkbox is never "empty" (an
      // unticked box is a real `false`, see `isEmptyValue` in validate.ts), so
      // `required` on one can never fire — it is a no-op the editor no longer
      // offers, and an existing file's stray flag is cleared here rather than
      // rejected, so a file that currently loads keeps loading.
      required: def.type === 'boolean' ? false : (def.required ?? false),
      children: def.children ? resolveDefs(def.children, id) : [],
    }
  })
}

/** Validate + resolve a raw schema array into ResolvedDef nodes. */
export function resolveSchema(defs: AnnotationDef[]): ResolvedDef[] {
  const resolved = resolveDefs(defs, '')
  assertInstanceBudget(resolved)
  return resolved
}

/**
 * The most instances an empty project may materialize. Generous next to any
 * real schema — a normal one has `min` 0 or 1 nearly everywhere, so it starts
 * at roughly one instance per field.
 */
const MAX_INITIAL_INSTANCES = 100_000

/**
 * Refuse a schema whose empty tree would be enormous.
 *
 * `min` is a lower bound on instance count, and `initTree`/`normalizeTree`
 * *materialize* `max(min, 1)` instances per node, recursively, at load — before
 * the reviewer has entered anything. Nested groups multiply, so the cost is the
 * product down each branch and the file describing it stays tiny: seven levels
 * each with `min: 7` is about 400 bytes and 820 000 instances, and ten levels
 * of ten is ~500 bytes and 10^10 — an out-of-memory kill of the whole process
 * during load, with no error dialog and no chance to close the file. A flat
 * `min: 1000000000` does the same in 139 bytes.
 *
 * Checked on the resolved schema rather than bounding `min` per node, because
 * a per-node cap cannot stop the nested case: any ceiling above 1 still
 * multiplies. The product is what has to be bounded, so the product is what is
 * measured.
 */
function assertInstanceBudget(defs: ResolvedDef[]): void {
  const total = countInstances(defs, MAX_INITIAL_INSTANCES)
  if (total > MAX_INITIAL_INSTANCES) {
    throw new SchemaError(
      `This schema would create at least ${MAX_INITIAL_INSTANCES} empty entries before anything is filled in. ` +
        'Lower the "min" values, or nest fewer repeated groups inside each other.',
    )
  }
}

/** Instances an empty tree materializes, stopping once past `cap` so a
 *  10^10 schema is rejected in the time it takes to exceed the budget. */
function countInstances(defs: ResolvedDef[], cap: number): number {
  let total = 0
  for (const def of defs) {
    const each = Math.max(def.min, 1)
    const children = def.children.length > 0 ? countInstances(def.children, cap) : 0
    total += each * (1 + children)
    if (total > cap) return total
  }
  return total
}

/** True if a node can occur more than once. */
export function isRepeatable(def: ResolvedDef): boolean {
  return def.max === null || def.max > 1
}

/** True if a node carries an editable value field. */
export function isField(def: ResolvedDef): boolean {
  return def.type !== undefined
}
