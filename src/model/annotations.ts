import type { ResolvedDef, FieldType } from './schema'
import { isField } from './schema'

/**
 * Annotation data mirrors the schema. At each level it is a map keyed by node
 * name; every key holds an array of instances (its length is bounded by the
 * node's min/max). Each instance may carry a `value` (if the node is a field)
 * and/or `children` (a nested tree).
 */

export type FieldValue = string | number | boolean | null

export interface InstanceNode {
  value?: FieldValue
  children?: AnnotationValueTree
}

export interface AnnotationValueTree {
  [nodeName: string]: InstanceNode[]
}

/** Default empty value for a field type. */
export function emptyValue(type: FieldType | undefined): FieldValue {
  switch (type) {
    case 'boolean':
      return false
    case 'number':
    case 'string':
      return null
    default:
      return null
  }
}

/** Build a single fresh instance for a node (recursively initialising children to their `min`). */
export function makeInstance(def: ResolvedDef): InstanceNode {
  const instance: InstanceNode = {}
  if (isField(def)) {
    instance.value = emptyValue(def.type)
  }
  if (def.children.length > 0) {
    instance.children = initTree(def.children)
  }
  return instance
}

/** Initialise a value tree for a list of sibling defs, each with `min` instances (at least 1 to bind to). */
export function initTree(defs: ResolvedDef[]): AnnotationValueTree {
  const tree: AnnotationValueTree = {}
  for (const def of defs) {
    const count = Math.max(def.min, 1)
    tree[def.name] = Array.from({ length: count }, () => makeInstance(def))
  }
  return tree
}

/**
 * Reconcile an existing (possibly partial/loaded) value tree against the schema:
 *  - drop keys not in the schema,
 *  - coerce each present instance's structure to the def,
 *  - pad up to `min` (and at least 1) instances,
 *  - clamp down to `max` if exceeded.
 */
export function normalizeTree(
  defs: ResolvedDef[],
  existing: AnnotationValueTree | undefined,
): AnnotationValueTree {
  const tree: AnnotationValueTree = {}
  for (const def of defs) {
    const raw = existing?.[def.name]
    let instances: InstanceNode[] = Array.isArray(raw)
      ? raw.map((inst) => normalizeInstance(def, inst))
      : []

    const min = Math.max(def.min, 1)
    while (instances.length < min) instances.push(makeInstance(def))
    if (def.max !== null && instances.length > def.max) {
      instances = instances.slice(0, def.max)
    }
    tree[def.name] = instances
  }
  return tree
}

function normalizeInstance(def: ResolvedDef, inst: InstanceNode | undefined): InstanceNode {
  const out: InstanceNode = {}
  if (isField(def)) {
    // The value tree is hand-editable, so an instance array element may be a
    // bare primitive (`"Study Type": ["RCT"]` instead of `[{value:"RCT"}]`)
    // rather than the `{value}` object shape. `'value' in inst` throws a raw
    // TypeError on a primitive — escaping `loadProject`'s contract to only ever
    // raise a friendly ProjectLoadError, and aborting a git pull-merge that
    // loads such a revision.
    //
    // The primitive is *adopted as the value*, not discarded: this walk is the
    // one that rewrites the file (unlike the read-only `collectAnnotationText`
    // / `isEmptyInstance`, where skipping merely displays nothing). Normalizing
    // the shorthand to an empty value would open the file cleanly and then let
    // the next ordinary save — or `finishPull`'s write-back — overwrite a real
    // answer with null, turning a loud crash into silent data loss. `false` for
    // a boolean is the same loss with the value flipped.
    const raw =
      inst && typeof inst === 'object'
        ? 'value' in inst
          ? (inst.value as FieldValue)
          : emptyValue(def.type)
        : (inst as unknown as FieldValue | undefined)
    out.value = raw === undefined ? emptyValue(def.type) : raw
  }
  if (def.children.length > 0) {
    out.children = normalizeTree(def.children, inst?.children)
  }
  return out
}

/** Whether another instance may be added (respecting `max`). */
export function canAdd(def: ResolvedDef, current: number): boolean {
  return def.max === null || current < def.max
}

/** Whether an instance may be removed (respecting `min`, minimum 1). */
export function canRemove(def: ResolvedDef, current: number): boolean {
  return current > Math.max(def.min, 1)
}

/**
 * Prune a value tree for serialization: drop the empty instances trailing the
 * end of each list, so saved files stay tidy. Required instances (up to `min`,
 * at least 1) are always kept.
 *
 * Only *trailing* empties go. An empty instance with a filled one after it is a
 * gap on purpose and is kept, because position carries meaning: consolidation
 * records which of each reviewer's entries are the same entry by lining their
 * lists up (see `consolidate/apply.ts`), and a reviewer with no entry for the
 * second slot holds an empty one there. Closing that gap would slide every
 * later entry down a slot and silently re-point the alignment at the wrong
 * entries on the next load.
 */
export function pruneTree(
  defs: ResolvedDef[],
  tree: AnnotationValueTree,
): AnnotationValueTree {
  const out: AnnotationValueTree = {}
  for (const def of defs) {
    const instances = tree[def.name] ?? []
    const pruned = instances.map((inst) => pruneInstance(def, inst))
    let last = pruned.length - 1
    while (last >= 0 && isEmptyInstance(def, pruned[last])) last--
    out[def.name] = pruned.slice(0, Math.max(Math.max(def.min, 1), last + 1))
  }
  return out
}

function pruneInstance(def: ResolvedDef, inst: InstanceNode): InstanceNode {
  const out: InstanceNode = {}
  if (isField(def)) out.value = inst.value ?? emptyValue(def.type)
  if (def.children.length > 0) out.children = pruneTree(def.children, inst.children ?? {})
  return out
}

/** True if any field anywhere in the tree has been filled in. */
export function hasAnnotations(defs: ResolvedDef[], tree: AnnotationValueTree): boolean {
  for (const def of defs) {
    const instances = tree[def.name] ?? []
    if (instances.some((inst) => !isEmptyInstance(def, inst))) return true
  }
  return false
}

/**
 * Flatten every filled-in field value under the tree into one lowercased,
 * space-joined string, for "search by annotation content" mode. Mirrors
 * `hasAnnotations`'s walk shape rather than a fresh traversal.
 *
 * Booleans are skipped: every paper has one for each boolean field (they
 * default to `false`, never absent), so including "true"/"false" would make
 * a query like "no" match nearly every paper regardless of what was actually
 * recorded — the opposite of a useful search.
 *
 * Defensive like the rest of this module's tree walks: the project JSON is
 * hand-editable, so a value tree may not match the schema's shape at runtime.
 */
export function annotationText(defs: ResolvedDef[], tree: AnnotationValueTree): string {
  const parts: string[] = []
  collectAnnotationText(defs, tree, parts)
  return parts.join(' ').toLowerCase()
}

function collectAnnotationText(defs: ResolvedDef[], tree: AnnotationValueTree, out: string[]): void {
  for (const def of defs) {
    const raw = tree?.[def.name]
    const instances = Array.isArray(raw) ? raw : []
    for (const inst of instances) {
      if (!inst || typeof inst !== 'object') continue
      if (isField(def)) {
        const v = inst.value
        if (typeof v === 'string' && v !== '') out.push(v)
        else if (typeof v === 'number' && !Number.isNaN(v)) out.push(String(v))
      }
      if (def.children.length > 0 && inst.children) {
        collectAnnotationText(def.children, inst.children, out)
      }
    }
  }
}

function isEmptyInstance(def: ResolvedDef, inst: InstanceNode): boolean {
  if (isField(def)) {
    const v = inst.value
    const fieldFilled =
      def.type === 'boolean' ? v === true : v !== null && v !== undefined && v !== ''
    if (fieldFilled) return false
  }
  if (def.children.length > 0 && inst.children) {
    for (const child of def.children) {
      const arr = inst.children[child.name] ?? []
      if (arr.some((c) => !isEmptyInstance(child, c))) return false
    }
  }
  return true
}
