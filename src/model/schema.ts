// [impl->req~dat-285~1]
import { z } from 'zod'
import { t } from '../i18n'

/**
 * The annotation schema is a nested taxonomy. Each node may be a leaf field
 * (has `type`), a group (has `children`, no `type`), or both.
 *
 * Cardinality: `min` (default 1) and `max` (default 1, `null` = unbounded),
 * also valid on group nodes for repeated sub-trees.
 */

// [impl->req~dat-110~1]
/**
 * `year` shares `number`'s on-disk shape (a JSON number), needing no new
 * `FieldValue` member or changes to `annotations.ts`. It adds real bounds
 * checking (`YEAR_MIN`/`YEAR_MAX` in `model/year.ts`) — see
 * `docs/annotation-schema.md` §3.1 for why a full `date` type was rejected.
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'year'

/**
 * One clause of a visibility gate. `field` is a sibling name, an ancestor-chain
 * name, or a slash-joined absolute path (`"Findings/Claim"`) — see
 * {@link AnnotationDef.visibleIf}.
 *
 * `equals` narrows "has any answer" to "holds one of these values"; only
 * booleans and `string` fields with `options` have a closed set to match, so
 * on any other field type `equals` is dropped at resolve time and the clause
 * degrades to plain "answered".
 */
export interface VisibleCondition {
  field: string
  /** Values that satisfy this clause; empty/absent = any answer. */
  equals?: (string | boolean)[]
}

/**
 * A visibility gate: entries combined with AND (`all`) or OR (`any`); a
 * single entry behaves the same under either mode.
 *
 * An entry may be another spec (its own `mode`), enabling mixed rules like
 * "A is Yes AND (B is RCT OR Survey)". Nesting is arbitrary depth; an empty
 * group is dropped at resolve time, same as an unusable condition.
 */
export interface VisibleIfSpec {
  mode: 'all' | 'any'
  conditions: VisibleIfEntry[]
}

/** One entry of a gate: a leaf condition, or a nested group of them. */
export type VisibleIfEntry = VisibleCondition | VisibleIfSpec

/** True when a gate entry is a nested group rather than a leaf condition. */
export function isConditionGroup(entry: VisibleIfEntry): entry is VisibleIfSpec {
  return 'conditions' in entry
}

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
  /**
   * Gates this node's visibility: a bare field name (shorthand for "hidden
   * until that field has an answer") or a {@link VisibleIfSpec} for AND/OR
   * and value matching. A bare name resolves as sibling, then ancestor-chain
   * field, then absolute path (see `resolveSpec`) — this order keeps files
   * written before paths existed resolving unchanged. A reference cannot
   * target this node or its own subtree (a hidden descendant can never be
   * answered). An invalid or stale reference is silently dropped at resolve
   * time rather than rejected; a spec left with no conditions gates nothing.
   */
  visibleIf?: string | VisibleIfSpec
  /** A repeatable node only: no two entries may hold the same answer. Defaults to false. */
  unique?: boolean
  /** With `unique` on a node with children: the child names that decide equality. Defaults to all. */
  uniqueBy?: string[]
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
  /** Normalized: the shorthand string form is expanded into a one-condition
   *  spec, and invalid conditions are dropped (see `resolveVisibleIf`). */
  visibleIf?: VisibleIfSpec
  unique?: boolean
  uniqueBy?: string[]
  children: ResolvedDef[]
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const fieldTypeSchema = z.enum(['string', 'number', 'boolean', 'year'])

const visibleConditionSchema: z.ZodType<VisibleCondition> = z.lazy(() =>
  z
    .object({
      field: z.string().min(1, t('store.schema.visibleFieldMissing')),
      equals: z.array(z.union([z.string(), z.boolean()])).optional(),
    })
    .strict(),
)

// Groups nest, so this is lazy for the same reason `annotationDefSchema` is.
// [impl->req~dat-60~1]
const visibleIfSpecSchema: z.ZodType<VisibleIfSpec> = z.lazy(() =>
  z
    .object({
      mode: z.enum(['all', 'any']),
      conditions: z
        .array(z.union([visibleConditionSchema, visibleIfSpecSchema]))
        .min(1, t('store.schema.visibleEmpty')),
    })
    .strict(),
)

/** The two accepted on-disk forms: a bare field name, or a full spec. */
const visibleIfInputSchema = z.union([z.string(), visibleIfSpecSchema])

// zod has no native recursion helper for input inference, so we type it lazily.
export const annotationDefSchema: z.ZodType<AnnotationDef> = z.lazy(() =>
  z
    .object({
      name: z.string().min(1, t('store.schema.nameEmpty')),
      type: fieldTypeSchema.optional(),
      min: z.number().int().min(0).optional(),
      max: z.union([z.number().int().min(1), z.null()]).optional(),
      description: z.string().optional(),
      options: z.array(z.string()).optional(),
      required: z.boolean().optional(),
      visibleIf: visibleIfInputSchema.optional(),
      unique: z.boolean().optional(),
      uniqueBy: z.array(z.string()).min(1, t('store.schema.uniqueByEmpty')).optional(),
      children: z.array(annotationDefSchema).optional(),
    })
    .strict()
    .superRefine((def, ctx) => {
      const min = def.min ?? 1
      const max = def.max === undefined ? 1 : def.max
      if (max !== null && max < min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('store.schema.maxMin', { name: def.name, max, min }),
        })
      }
      if (!def.type && (!def.children || def.children.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('store.schema.typeOrChildren', { name: def.name }),
        })
      }
      if (def.options && def.options.length > 0 && def.type !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('store.schema.optionsOnString', { name: def.name }),
        })
      }
      if (def.required && !def.type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('store.schema.requiredOnField', { name: def.name }),
        })
      }
    }),
)

// [impl->req~dat-40~1]
export const paperSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    authors: z.array(z.string()).default([]),
    doi: z.string().optional(),
    /** Loosely typed: `"year": "2021"` is a plausible hand-edit and loads fine
     *  today via `.passthrough()`, so tightening to `z.number()` would break
     *  it. Repaired-or-dropped structurally in `project.ts` (`parseYear`). */
    year: z.unknown().optional(),
    /** Journal, conference/proceedings, or publisher. One free-text field
     *  because no import format (BibTeX, RIS, CSL) reliably distinguishes
     *  them, and a screener just needs to read "TSE" or "ICSE 2024". */
    venue: z.string().optional(),
    /** The paper's abstract. Screening reads this when there is no PDF. */
    abstract: z.string().optional(),
    /** True when `abstract` came from the PDF-text heuristic in `pdfMeta.ts`
     *  rather than being authored/imported/typed. Loosely typed and
     *  normalized structurally in `project.ts`, same as `annotations`/`reviews`. */
    abstractFromPdf: z.boolean().optional(),
    // "pdf required" is enforced in `projectSchema`'s `superRefine` instead,
    // which knows whether this is a screening project (PDFs usually absent).
    pdf: z.string().default(''),
    // Loosely typed; validated/normalized structurally in project.ts so a
    // malformed entry is dropped rather than failing the whole file to load.
    annotations: z.record(z.unknown()).optional(),
    aiUsage: z.unknown().optional(),
    reviews: z.unknown().optional(),
    // Ditto — canonical field paths, deduped/validated in project.ts.
    equal: z.unknown().optional(),
  })
  .passthrough()

// [impl->req~dat-260~1]
/**
 * A screening project's one authorable setting: the exclusion reasons.
 * `config.screening`'s presence is what makes a project a screening project;
 * the rest of its schema is derived (see `src/screening/schema.ts`).
 */
export interface ScreeningConfig {
  /** Non-empty, trimmed, deduped by `project.ts`. Order is the order reported. */
  reasons: string[]
}

const screeningConfigSchema: z.ZodType<ScreeningConfig> = z.lazy(() =>
  z
    .object({
      reasons: z
        .array(z.string())
        .min(1, t('store.schema.reasonsRequired')),
    })
    .strict(),
)

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
      // Optional here because a screening project's schema is derived, not
      // authored; every other project still needs one, enforced below in
      // `superRefine` where `screening`'s presence can be taken into account.
      schema: z.array(annotationDefSchema).optional(),
      /** When false, the provider of this file has disabled AI-assisted annotation. */
      ai: z.boolean().optional(),
      /** When false, reviewers do not sign papers off by hand — a fulfilled
       *  schema alone counts as finished. See `Project.finishCheckbox`. */
      finishCheckbox: z.boolean().optional(),
      /** Number of independent reviewers. Absent or 1 = single-reviewer (the default). */
      reviewers: z.number().int().min(1).max(10).optional(),
      /** When true, the last reviewer seat is dedicated to the AI. See `Project.aiSeat`. */
      aiSeat: z.boolean().optional(),
      screening: screeningConfigSchema.optional(),
    }),
    papers: z.array(paperSchema),
  })
  .passthrough()
  .superRefine((raw, ctx) => {
    // A screening project's schema is derived, not authored; everyone else
    // still must supply one.
    if (!raw.config.screening && (!raw.config.schema || raw.config.schema.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'schema'],
        message: t('store.schema.nodeRequired'),
      })
    }
    // Screening is normally done on title + abstract from a reference-manager
    // export with no PDFs at all, so this rule is skipped there.
    if (!raw.config.screening) {
      raw.papers.forEach((p, i) => {
        if (!p.pdf) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['papers', i, 'pdf'],
            message: t('store.schema.paperPdf'),
          })
        }
      })
    }
  })

export type RawProject = z.infer<typeof projectSchema>
// [impl->req~dat-120~1]
export type RawPaper = z.infer<typeof paperSchema>

// ---------------------------------------------------------------------------
// Resolution: apply defaults, assign ids, enforce sibling-name uniqueness
// ---------------------------------------------------------------------------

export class SchemaError extends Error {}

/**
 * Normalize `def.visibleIf` into a {@link VisibleIfSpec}, dropping what cannot
 * be honored (self/subtree references, unresolvable names, `equals` on a
 * field with no closed set of answers). A spec left with no conditions
 * becomes `undefined`.
 */
function resolveVisibleIf(
  def: AnnotationDef,
  siblings: AnnotationDef[],
  ancestorFields: AnnotationDef[],
  root: AnnotationDef[],
  selfId: string,
): VisibleIfSpec | undefined {
  const raw = def.visibleIf
  if (raw === undefined) return undefined
  const spec: VisibleIfSpec =
    typeof raw === 'string' ? { mode: 'all', conditions: [{ field: raw }] } : raw

  return resolveSpec(spec, def, siblings, ancestorFields, root, selfId)
}

/** `resolveVisibleIf`'s recursion: the same rules applied to a nested group. */
function resolveSpec(
  spec: VisibleIfSpec,
  def: AnnotationDef,
  siblings: AnnotationDef[],
  ancestorFields: AnnotationDef[],
  root: AnnotationDef[],
  selfId: string,
): VisibleIfSpec | undefined {
  const conditions: VisibleIfEntry[] = []
  for (const entry of spec.conditions) {
    if (isConditionGroup(entry)) {
      // [impl->req~dat-130~1]
      const nested = resolveSpec(entry, def, siblings, ancestorFields, root, selfId)
      if (nested) conditions.push(nested)
      continue
    }
    if (entry.field === def.name) continue
    // Sibling, then ancestor chain, then absolute path (see `AnnotationDef.visibleIf`).
    // Only the path route needs a subtree check — a sibling/ancestor can't be in it.
    // [impl->req~dat-140~1]
    // [impl->req~dat-130~1]
    const target =
      siblings.find((sib) => sib.name === entry.field && sib.type !== undefined) ??
      ancestorFields.find((anc) => anc.name === entry.field) ??
      resolveFieldPath(root, entry.field, selfId)
    if (!target) continue
    // [impl->req~dat-140~1]
    const equals = resolveEquals(target, entry.equals)
    conditions.push(equals.length > 0 ? { field: entry.field, equals } : { field: entry.field })
  }
  if (conditions.length === 0) return undefined
  return { mode: spec.mode, conditions }
}

/**
 * Walk a slash-joined absolute path (`"Findings/Claim"`, the shape
 * {@link ResolvedDef.id} uses) from the schema root. Returns nothing when the
 * path targets the gated node's own subtree (unanswerable, so the gate could
 * never open), a segment doesn't exist, or it lands on a group with no `type`.
 */
function resolveFieldPath(
  root: AnnotationDef[],
  path: string,
  selfId: string,
): AnnotationDef | undefined {
  if (path === selfId || path.startsWith(`${selfId}/`)) return undefined
  let level = root
  // [impl->req~dat-150~1]
  let found: AnnotationDef | undefined
  for (const seg of path.split('/')) {
    found = level.find((d) => d.name === seg)
    if (!found) return undefined
    level = found.children ?? []
  }
  return found && found.type !== undefined ? found : undefined
}

// [impl->req~dat-150~1]
/** The subset of `equals` the target field can actually hold; empty means the
 *  condition falls back to "answered". */
function resolveEquals(
  target: AnnotationDef,
  equals: (string | boolean)[] | undefined,
): (string | boolean)[] {
  if (!equals || equals.length === 0) return []
  if (target.type === 'boolean') {
    return [...new Set(equals.filter((v) => typeof v === 'boolean'))]
  }
  if (target.type === 'string' && target.options && target.options.length > 0) {
    const allowed = new Set(target.options)
    return [...new Set(equals.filter((v): v is string => typeof v === 'string' && allowed.has(v)))]
  }
  return []
}

/** A gate on one field being answered — the shorthand form, expanded. */
export function gateOn(field: string): VisibleIfSpec {
  return { mode: 'all', conditions: [{ field }] }
}

/** The compact on-disk form: the bare-name shorthand when that says the same
 *  thing, the full spec otherwise. Keeps a hand-written schema (and a file
 *  written before value conditions existed) round-tripping unchanged. */
export function compactVisibleIf(spec: VisibleIfSpec): string | VisibleIfSpec {
  const [only] = spec.conditions
  if (
    spec.conditions.length === 1 &&
    !isConditionGroup(only) &&
    (!only.equals || only.equals.length === 0)
  ) {
    return only.field
  }
  return spec
}

function resolveDefs(
  defs: AnnotationDef[],
  parentPath: string,
  // Unchanged all the way down: a `visibleIf` may name its target by absolute
  // path from here (see `resolveFieldPath`), reaching a cousin or unrelated branch.
  root: AnnotationDef[],
  // This node's direct ancestor chain only (never an ancestor's siblings),
  // that `visibleIf` may also reference. Whole defs, not names, since a value
  // condition must check the target's type/options.
  ancestorFields: AnnotationDef[] = [],
): ResolvedDef[] {
  const seen = new Set<string>()
  return defs.map((def) => {
    // Deliberately NOT trimmed: `normalizeTree` looks answers up by the
    // resolved def name, so trimming here would miss a stored `"Claim "` key
    // and silently replace a real answer with an empty instance on load.
    // A field called `__proto__` would hit `Object.prototype`'s setter instead
    // of becoming an own property: it reads/edits fine but `Object.keys`/
    // `JSON.stringify` skip it, so answers vanish on save with no error.
    // Rejected rather than silently renamed, since this can only come from a
    // hand-edited file.
    if (def.name === '__proto__') {
      throw new SchemaError(
        t('store.schema.protoName', { where: parentPath ? t('store.schema.protoWhere', { parent: parentPath }) : '' }),
      )
    }
    if (seen.has(def.name)) {
      throw new SchemaError(
        t('store.schema.duplicate', { name: def.name, place: placeOf(parentPath) }),
      )
    }
    // Siblings differing only by whitespace are rejected too: `parsePath`
    // trims a segment, so "Claim " and "Claim" would resolve to the same
    // canonical path and a committed answer could land in the wrong field.
    const clash = [...seen].find((n) => n.trim() === def.name.trim())
    if (clash !== undefined) {
      throw new SchemaError(t('store.schema.nameClash', { a: clash, b: def.name, place: placeOf(parentPath) }))
    }
    seen.add(def.name)

    const id = parentPath ? `${parentPath}/${def.name}` : def.name
    const min = def.min ?? 1
    const max = def.max === undefined ? 1 : def.max
    assertUniqueOptions(def, id, max)
    return {
      id,
      name: def.name,
      type: def.type,
      min,
      max,
      description: def.description,
      options: def.options,
      // Dropped for a boolean: an unticked box is a real `false`, never
      // "empty" (see `isEmptyValue` in validate.ts), so `required` can never
      // fire there — cleared silently so a file with a stray flag still loads.
      required: def.type === 'boolean' ? false : (def.required ?? false),
      // See `AnnotationDef.visibleIf`; invalid references are dropped silently.
      visibleIf: resolveVisibleIf(def, defs, ancestorFields, root, id),
      ...(def.unique ? { unique: true } : {}),
      ...(def.unique && def.uniqueBy ? { uniqueBy: def.uniqueBy } : {}),
      children: def.children
        ? resolveDefs(
            def.children,
            id,
            root,
            def.type !== undefined ? [...ancestorFields, def] : ancestorFields,
          )
        : [],
    }
  })
}

function placeOf(parentPath: string): string {
  return parentPath ? t('store.schema.placeUnder', { parent: parentPath }) : t('store.schema.placeTop')
}

// [impl->req~dat-400~1]
function assertUniqueOptions(def: AnnotationDef, id: string, max: number | null): void {
  if (def.unique && max === 1) {
    throw new SchemaError(t('store.schema.uniqueNotRepeatable', { id }))
  }
  if (def.uniqueBy === undefined) return
  if (!def.unique) {
    throw new SchemaError(t('store.schema.uniqueByNeedsUnique', { id }))
  }
  const children = def.children ?? []
  if (children.length === 0) {
    throw new SchemaError(t('store.schema.uniqueByNoChildren', { id }))
  }
  const unknown = def.uniqueBy.filter((n) => !children.some((c) => c.name === n))
  if (unknown.length > 0) {
    throw new SchemaError(
      t('store.schema.uniqueByUnknown', { id, names: unknown.map((n) => `"${n}"`).join(', ') }),
    )
  }
}

/** Validate + resolve a raw schema array into ResolvedDef nodes. */
export function resolveSchema(defs: AnnotationDef[]): ResolvedDef[] {
  const resolved = resolveDefs(defs, '', defs)
  assertInstanceBudget(resolved)
  return resolved
}

/**
 * The most instances an empty project may materialize. Generous next to any
 * real schema, which has `min` 0 or 1 nearly everywhere.
 */
const MAX_INITIAL_INSTANCES = 100_000

/**
 * Refuse a schema whose empty tree would be enormous. `initTree`/`normalizeTree`
 * materialize `max(min, 1)` instances per node recursively at load, and nested
 * groups multiply the cost down each branch — a tiny file (ten levels of
 * `min: 10`) can describe 10^10 instances and OOM-kill the process on load.
 * Checked on the resolved schema, not per-node, because any per-node cap above
 * 1 still multiplies arbitrarily deep; only the product can be bounded.
 */
function assertInstanceBudget(defs: ResolvedDef[]): void {
  const total = countInstances(defs, MAX_INITIAL_INSTANCES)
  if (total > MAX_INITIAL_INSTANCES) {
    throw new SchemaError(t('store.schema.budget', { max: MAX_INITIAL_INSTANCES }))
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
