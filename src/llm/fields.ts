import type { ResolvedDef } from '../model/schema'
import { isField } from '../model/schema'
import {
  isFieldVisible,
  makeInstance,
  type AnnotationValueTree,
  type FieldValue,
  type InstanceNode,
} from '../model/annotations'
import { isEmptyValue } from '../model/validate'
import { formatPath, resolvePath, MAX_UNBOUNDED_INDEX, type RawSeg, type ResolvedPath } from './paths'
import type { LlmAnswer } from './types'

// [impl->req~llm-100~1]
/** One field the AI will be asked about, with the value it currently holds. */
export interface FieldTarget {
  /** Canonical path, e.g. "Findings/Evidence/Metric". */
  path: string
  def: ResolvedDef
  value: FieldValue | undefined
}

/**
 * Whether the AI should be asked to answer this field.
 *
 * For strings and numbers this is exactly `validate.ts`'s notion of empty, so
 * "the AI fills what the validator would complain about" holds.
 *
 * Booleans need their own rule. The data model cannot represent an *unanswered*
 * boolean — an unticked box and a deliberate "false" are the same `false`, which
 * is why `isEmptyValue` treats booleans as never empty. Applying that rule here
 * would mean the AI could never propose a value for a boolean field at all,
 * including the archetypal one ("Relevant"). So a boolean is offered unless it is
 * already ticked: the AI can propose flipping it to true, never to false, and it
 * can never silently clear a box the reviewer ticked. The reviewer still approves
 * every row before anything is written.
 */
export function isUnanswered(def: ResolvedDef, value: FieldValue | undefined): boolean {
  if (def.type === 'boolean') return value !== true
  return isEmptyValue(def.type, value)
}

/**
 * Every field in the schema that is still unanswered for this paper, in schema
 * order. Walks the *existing* instances only: a repeatable node contributes the
 * entries it currently has. The model may still record further entries by naming
 * the next free index (the prompt says so, and `resolvePath` allows it) — those
 * instances get created at apply time.
 */
export function unansweredFields(
  schema: ResolvedDef[],
  tree: AnnotationValueTree | undefined,
): FieldTarget[] {
  return fieldTargets(schema, tree, (def, value) => isUnanswered(def, value))
}

// [impl->req~llm-610~1]
// [impl->req~llm-760~1]
/**
 * Every visible field whose existing value satisfies `keep`, in schema order.
 * Shared by `unansweredFields` and `answeredFields` (recheck.ts) so both see
 * the same instances. A field hidden by `visibleIf` is skipped, exactly as
 * `completeness.ts` and `validate.ts` skip it. `gated` tells `keep` whether
 * the field or one of its ancestors carries a `visibleIf`.
 */
export function fieldTargets(
  schema: ResolvedDef[],
  tree: AnnotationValueTree | undefined,
  keep: (def: ResolvedDef, value: FieldValue | undefined, gated: boolean) => boolean,
): FieldTarget[] {
  const out: FieldTarget[] = []
  const root = tree ?? {}
  walk(schema, root, [], (def, value, segs, gated) => {
    if (isField(def) && keep(def, value, gated)) out.push({ path: formatPath(segs), def, value })
  }, {}, root, false)
  return out
}

type Visit = (def: ResolvedDef, value: FieldValue | undefined, segs: RawSeg[], gated: boolean) => void

function walk(
  defs: ResolvedDef[],
  tree: AnnotationValueTree | undefined,
  prefix: RawSeg[],
  visit: Visit,
  gateAncestors: Record<string, FieldValue>,
  gateRoot: AnnotationValueTree,
  gated: boolean,
): void {
  for (const def of defs) {
    if (!isFieldVisible(def, tree ?? {}, gateAncestors, gateRoot)) continue
    // A normalized tree always has at least one instance per node, but the JSON is
    // hand-editable and may hold anything here. A missing node — or one holding
    // something other than a list of instances — is treated as a single empty
    // instance: the AI can then offer to fill it, and `validate.ts` separately
    // reports the malformed shape to the reviewer.
    const raw = tree?.[def.name]
    const instances = Array.isArray(raw) ? raw : [{}]
    const g = gated || def.visibleIf !== undefined
    instances.forEach((inst, index) => {
      const segs = [...prefix, { name: def.name, index }]
      visit(def, inst?.value, segs, g)
      if (def.children.length > 0) {
        const ancestors = isField(def) ? { ...gateAncestors, [def.name]: inst?.value ?? null } : gateAncestors
        walk(def.children, inst?.children, segs, visit, ancestors, gateRoot, g)
      }
    })
  }
}

// [impl->req~llm-760~1]
/** The schema as the reviewer sees it for `tree`: a node hidden in every instance is left out. */
export function visibleSchema(schema: ResolvedDef[], tree: AnnotationValueTree | undefined): ResolvedDef[] {
  const seen = new Set<ResolvedDef>()
  const root = tree ?? {}
  walk(schema, root, [], (def) => seen.add(def), {}, root, false)
  const prune = (defs: ResolvedDef[]): ResolvedDef[] =>
    defs.filter((d) => seen.has(d)).map((d) => ({ ...d, children: prune(d.children) }))
  return prune(schema)
}

/**
 * Find (or create) instance `index` of `name` in `tree`, padding the list with
 * empty instances as needed. Returns null when the name is unknown at this level
 * or the index would exceed the node's `max`.
 */
function ensureInstance(
  defs: ResolvedDef[],
  tree: AnnotationValueTree,
  name: string,
  index: number,
): { inst: InstanceNode; def: ResolvedDef } | null {
  const def = defs.find((d) => d.name === name)
  if (!def) return null
  // See `MAX_UNBOUNDED_INDEX`: the push loop below materializes every instance
  // up to `index`, so an unbounded node still needs a ceiling.
  if (index >= (def.max === null ? MAX_UNBOUNDED_INDEX : def.max)) return null

  // The JSON is hand-editable, so this key may not hold a list at all — replace
  // rather than crash; a malformed node has no answer worth preserving.
  let list = tree[name]
  if (!Array.isArray(list)) {
    list = []
    tree[name] = list
  }
  while (list.length <= index) list.push(makeInstance(def))
  return { inst: list[index], def }
}

/**
 * Write `value` at `at` in `tree`, creating instances along the path. The model
 * may address a not-yet-existing entry of a repeatable node (how it records a
 * further Finding). Returns false when a step exceeds a node's `max`.
 */
export function writeValue(
  schema: ResolvedDef[],
  tree: AnnotationValueTree,
  at: ResolvedPath,
  value: FieldValue,
): boolean {
  let level = schema
  let cursor = tree
  for (const seg of at.path) {
    const step = ensureInstance(level, cursor, seg.name, seg.index)
    if (!step) return false
    if (!step.inst.children) step.inst.children = {}
    cursor = step.inst.children
    level = step.def.children
  }
  const leaf = ensureInstance(level, cursor, at.name, at.index)
  if (!leaf) return false
  leaf.inst.value = value
  return true
}

// [impl->req~llm-760~1]
/** A copy of `tree` with `fields` written in, as if the reviewer applied them all. */
export function withAnswers(
  schema: ResolvedDef[],
  tree: AnnotationValueTree | undefined,
  fields: { path: string; value: FieldValue }[],
): AnnotationValueTree {
  const out: AnnotationValueTree = structuredClone(tree ?? {})
  for (const f of fields) {
    const at = resolvePath(schema, f.path, { maxUnboundedIndex: MAX_UNBOUNDED_INDEX })
    if (at) writeValue(schema, out, at, f.value)
  }
  return out
}

// [impl->req~llm-760~1]
/**
 * Drop proposals for fields that stay hidden once every kept proposal is
 * written in. Repeats until stable, since a dropped gate can hide another field.
 */
export function dropHiddenSuggestions<T extends { path: string; value: FieldValue }>(
  schema: ResolvedDef[],
  tree: AnnotationValueTree | undefined,
  fields: T[],
): { kept: T[]; dropped: T[] } {
  let kept = fields
  for (;;) {
    const visible = new Set(fieldTargets(schema, withAnswers(schema, tree, kept), () => true).map((t) => t.path))
    const next = kept.filter((f) => {
      const at = resolvePath(schema, f.path, { maxUnboundedIndex: MAX_UNBOUNDED_INDEX })
      return !at || visible.has(at.canonical)
    })
    if (next.length === kept.length) return { kept, dropped: fields.filter((f) => !kept.includes(f)) }
    kept = next
  }
}

/** At most this many follow-up rounds for fields revealed by earlier answers. */
export const MAX_CONDITION_PASSES = 5

// [impl->req~llm-760~1]
/**
 * Ask `targets`, then ask again for each round of gated fields the answers so
 * far reveal, until none is left. `ask` gets each round's targets and the tree
 * with all answers so far written in, so the prompt shows that visible tree.
 * A field visible from the start is never asked twice, even if the reviewer
 * left it out of `targets`.
 */
export async function askInDependencyOrder(
  schema: ResolvedDef[],
  tree: AnnotationValueTree | undefined,
  targets: FieldTarget[],
  ask: (targets: FieldTarget[], tree: AnnotationValueTree) => Promise<LlmAnswer>,
): Promise<LlmAnswer> {
  const asked = new Set([...unansweredFields(schema, tree), ...targets].map((t) => t.path))
  const answer: LlmAnswer = { fields: [], skipped: [], rejected: [] }
  let pending = targets
  let current = tree ?? {}
  for (let pass = 0; pass <= MAX_CONDITION_PASSES; pass++) {
    const r = await ask(pending, current)
    answer.fields.push(...r.fields)
    answer.skipped.push(...r.skipped)
    answer.rejected.push(...r.rejected)
    if (r.schemaRemarks?.length) answer.schemaRemarks = [...(answer.schemaRemarks ?? []), ...r.schemaRemarks]
    current = withAnswers(schema, tree, answer.fields)
    pending = fieldTargets(schema, current, (def, value, gated) => gated && isUnanswered(def, value)).filter(
      (t) => !asked.has(t.path),
    )
    if (pending.length === 0) break
    for (const t of pending) asked.add(t.path)
  }
  return answer
}
