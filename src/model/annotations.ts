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
    out.value = inst && 'value' in inst ? (inst.value as FieldValue) : emptyValue(def.type)
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
 * Prune a value tree for serialization: remove instances that are entirely
 * empty *beyond* the required minimum, so saved files stay tidy. Required
 * instances (up to `min`, at least 1) are always kept.
 */
export function pruneTree(
  defs: ResolvedDef[],
  tree: AnnotationValueTree,
): AnnotationValueTree {
  const out: AnnotationValueTree = {}
  for (const def of defs) {
    const instances = tree[def.name] ?? []
    const pruned = instances.map((inst) => pruneInstance(def, inst))
    const keepMin = Math.max(def.min, 1)
    // Keep the first `keepMin`; for the rest, drop trailing empties.
    const result: InstanceNode[] = []
    for (let i = 0; i < pruned.length; i++) {
      if (i < keepMin || !isEmptyInstance(def, pruned[i])) {
        result.push(pruned[i])
      }
    }
    out[def.name] = result
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
