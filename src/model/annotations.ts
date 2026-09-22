import type {
  ResolvedDef,
  FieldType,
  VisibleCondition,
  VisibleIfEntry,
  VisibleIfSpec,
} from './schema'
import { isConditionGroup, isField } from './schema'

/**
 * Annotation data mirrors the schema: a map keyed by node name, each key
 * holding an array of instances (length bounded by the node's min/max).
 */

export type FieldValue = string | number | boolean | null

export interface InstanceNode {
  value?: FieldValue
  children?: AnnotationValueTree
}

export interface AnnotationValueTree {
  [nodeName: string]: InstanceNode[]
}

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

/** Build a fresh instance, recursively initialising children to their `min`. */
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

/** Initialise a value tree with each def's `min` instances (at least 1, so there's always one to bind to). */
export function initTree(defs: ResolvedDef[]): AnnotationValueTree {
  const tree: AnnotationValueTree = {}
  for (const def of defs) {
    const count = Math.max(def.min, 1)
    tree[def.name] = Array.from({ length: count }, () => makeInstance(def))
  }
  return tree
}

/**
 * The parts of `tree` the current schema has no def for — answers left behind
 * when a field was removed or renamed.
 *
 * They are carried verbatim through load and save rather than dropped.
 * Renaming a field is one person's edit to `project.json`, but the answers
 * under the old name may be several other reviewers' work that has not been
 * pulled yet; pruning them on the next load made that one edit destroy data
 * nobody could get back. Kept, the rename is reversible — restore the name, or
 * let git bring the newer schema in, and the answers are still there.
 *
 * This level only: a def that merely lost some of its children keeps them
 * through `normalizeTree`'s own recursion.
 */
export function orphanedNodes(
  defs: ResolvedDef[],
  tree: AnnotationValueTree | undefined,
): AnnotationValueTree {
  if (!tree) return {}
  const known = new Set(defs.map((d) => d.name))
  const out: AnnotationValueTree = {}
  for (const [name, value] of Object.entries(tree)) {
    // Only nodes somebody actually answered. `normalizeTree` materializes an
    // empty instance for every def, so a field the schema had a moment ago
    // leaves a placeholder behind — carrying those would resurrect files full
    // of nothing and make every schema edit look like a data change.
    if (!known.has(name) && Array.isArray(value) && value.some(instanceHoldsAnswer)) out[name] = value
  }
  return out
}

/**
 * Is this a real recorded answer? An unticked checkbox is not evidence of
 * anything (every boolean reads `false` whether or not anyone looked), and a
 * blank or whitespace-only string is not an answer either.
 */
export function isRecordedAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'number') return Number.isFinite(value)
  return false
}

/** Does this instance, or anything nested beneath it, hold a recorded answer?
 *  Def-free on purpose — it also has to judge data the schema no longer
 *  describes (see `orphanedNodes`). */
export function instanceHoldsAnswer(inst: unknown): boolean {
  if (!inst || typeof inst !== 'object') return false
  const node = inst as InstanceNode
  if (isRecordedAnswer(node.value)) return true
  const children = node.children
  if (!children || typeof children !== 'object' || Array.isArray(children)) return false
  for (const list of Object.values(children)) {
    if (Array.isArray(list) && list.some(instanceHoldsAnswer)) return true
  }
  return false
}

/**
 * Reconcile a loaded (possibly partial) value tree against the schema: coerce
 * each instance to the def's shape, pad/clamp to min (at least 1) / max, and
 * carry anything the schema no longer knows about through untouched (see
 * `orphanedNodes`).
 */
export function normalizeTree(
  defs: ResolvedDef[],
  existing: AnnotationValueTree | undefined,
): AnnotationValueTree {
  const tree: AnnotationValueTree = {}
  for (const def of defs) {
    const raw = existing?.[def.name]
    // A hand-edited file may hold a single entry instead of a list (e.g.
    // `"Study Type": "RCT"`). Adopt it as that one entry rather than dropping
    // it, since this walk rewrites the file and discarding would silently
    // lose the answer on the next save. `null`/`undefined` stay absent.
    const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw as InstanceNode]
    let instances: InstanceNode[] = list.map((inst) => normalizeInstance(def, inst))

    const min = Math.max(def.min, 1)
    while (instances.length < min) instances.push(makeInstance(def))
    if (def.max !== null && instances.length > def.max) {
      instances = instances.slice(0, def.max)
    }
    tree[def.name] = instances
  }
  return Object.assign(tree, orphanedNodes(defs, existing))
}

function normalizeInstance(def: ResolvedDef, inst: InstanceNode | undefined): InstanceNode {
  const out: InstanceNode = {}
  if (isField(def)) {
    // An instance array element may be a bare primitive (`["RCT"]`) instead of
    // `[{value:"RCT"}]` in hand-edited data; `'value' in inst` would throw on
    // it. Adopt the primitive as the value rather than discarding it — this
    // walk rewrites the file, so dropping it would overwrite a real answer
    // with null/false on the next save.
    const raw =
      inst && typeof inst === 'object'
        ? 'value' in inst
          ? (inst.value as FieldValue)
          : emptyValue(def.type)
        : (inst as unknown as FieldValue | undefined)
    out.value = raw === undefined ? emptyValue(def.type) : raw
  }
  // Not gated on `def.children.length > 0`: a node that lost *every* child
  // still has answers beneath the names it used to have, and they are orphans
  // exactly like a removed top-level field's. `normalizeTree` with no defs
  // returns precisely those, so the same rule covers both cases (losing some
  // children is already handled by its recursion). Set only when there is
  // something to hold, so an ordinary leaf field gains no empty `children`.
  const children = normalizeTree(def.children, inst?.children)
  if (def.children.length > 0 || Object.keys(children).length > 0) out.children = children
  return out
}

export function canAdd(def: ResolvedDef, current: number): boolean {
  return def.max === null || current < def.max
}

/** Blocks removal below `min`, floored at 1. */
export function canRemove(def: ResolvedDef, current: number): boolean {
  return current > Math.max(def.min, 1)
}

/**
 * Prune trailing empty instances from each list before serialization (down to
 * `min`, at least 1). Only *trailing* empties are dropped — an empty slot
 * before a filled one is kept because consolidation aligns reviewers' entries
 * by list position (see `consolidate/apply.ts`); closing the gap would
 * silently shift later entries out of alignment.
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
    // `isEmptyInstance` judges the current schema, under which an orphaned
    // subtree is nothing — so without the second test, dropping trailing empty
    // entries is what would delete the answers a node losing its children was
    // meant to keep. Deliberately not folded into `isEmptyInstance`: that also
    // backs `hasAnnotations`, and an orphan should stay invisible to the UI
    // exactly as a top-level one does, not make a paper read as annotated.
    while (last >= 0 && isEmptyInstance(def, pruned[last]) && !holdsOrphans(def, pruned[last])) last--
    out[def.name] = pruned.slice(0, Math.max(Math.max(def.min, 1), last + 1))
  }
  return Object.assign(out, orphanedNodes(defs, tree))
}

function pruneInstance(def: ResolvedDef, inst: InstanceNode): InstanceNode {
  const out: InstanceNode = {}
  if (isField(def)) out.value = inst.value ?? emptyValue(def.type)
  // Same reasoning as `normalizeInstance`: `pruneTree` with no defs yields
  // just the orphans, so a node that lost every child still writes them back.
  const children = pruneTree(def.children, inst.children ?? {})
  if (def.children.length > 0 || Object.keys(children).length > 0) out.children = children
  return out
}

export function hasAnnotations(defs: ResolvedDef[], tree: AnnotationValueTree): boolean {
  for (const def of defs) {
    const instances = tree[def.name] ?? []
    if (instances.some((inst) => !isEmptyInstance(def, inst))) return true
  }
  return false
}

/**
 * Whether `def` should be shown, given the sibling answers in `container` and
 * the ancestor-chain answers in `ancestors` (keyed by name). A gate's field
 * name resolves against `container`, then `ancestors`, then — if `root` (the
 * whole value tree) is passed — as a slash-joined absolute path from the
 * schema root, for gates on a cousin or unrelated branch.
 *
 * "Answered" means `true` for a boolean, non-null/non-empty otherwise
 * (deliberately not type-aware, since a boolean defaults to `false` which
 * already reads as unanswered). Fails open (visible) if the name resolves
 * nowhere, so malformed/stale data never hides a field.
 *
 * A path walk always reads instance 0 of a repeatable group — outside its own
 * lineage there's no "current" instance — unlike a bare name via
 * `container`/`ancestors`, which gets the actual per-instance answer.
 */
export function isFieldVisible(
  def: ResolvedDef,
  container: AnnotationValueTree,
  ancestors: Record<string, FieldValue> = {},
  root?: AnnotationValueTree,
): boolean {
  const spec = def.visibleIf
  if (!spec) return true
  return specHolds(spec, container, ancestors, root)
}

/** A gate (or one of its nested groups): AND for `all`, OR for `any`. */
function specHolds(
  spec: VisibleIfSpec,
  container: AnnotationValueTree,
  ancestors: Record<string, FieldValue>,
  root: AnnotationValueTree | undefined,
): boolean {
  const holds = (entry: VisibleIfEntry) =>
    isConditionGroup(entry)
      ? specHolds(entry, container, ancestors, root)
      : conditionHolds(entry, container, ancestors, root)
  return spec.mode === 'any' ? spec.conditions.some(holds) : spec.conditions.every(holds)
}

/**
 * One clause of a gate: without `equals`, the "is it answered" test; with it,
 * the answer must be one of the listed values. Fails open per clause if the
 * field is found in none of `container`, `ancestors`, `root`.
 */
function conditionHolds(
  cond: VisibleCondition,
  container: AnnotationValueTree,
  ancestors: Record<string, FieldValue>,
  root: AnnotationValueTree | undefined,
): boolean {
  const localInst = container[cond.field]?.[0]
  let v: FieldValue | undefined
  if (localInst) {
    v = localInst.value
  } else if (cond.field in ancestors) {
    v = ancestors[cond.field]
  } else {
    const remote = root && instanceAtPath(root, cond.field)
    if (!remote) return true
    v = remote.value
  }
  if (cond.equals && cond.equals.length > 0) return cond.equals.some((want) => want === v)
  return v !== null && v !== undefined && v !== '' && v !== false
}

/** Instance 0 at every level along a slash-joined absolute path (see `isFieldVisible`). */
function instanceAtPath(
  root: AnnotationValueTree,
  path: string,
): InstanceNode | undefined {
  let tree: AnnotationValueTree | undefined = root
  let inst: InstanceNode | undefined
  for (const seg of path.split('/')) {
    inst = tree?.[seg]?.[0]
    if (!inst) return undefined
    tree = inst.children
  }
  return inst
}

/**
 * Flatten every filled-in field value into one lowercased, space-joined
 * string for "search by annotation content" mode. Booleans are skipped:
 * every paper has one (never absent, defaults `false`), so including
 * "true"/"false" would make a query like "no" match almost everything.
 */
export function annotationText(defs: ResolvedDef[], tree: AnnotationValueTree, caseSensitive = false): string {
  const parts: string[] = []
  collectAnnotationText(defs, tree, parts)
  const joined = parts.join(' ')
  return caseSensitive ? joined : joined.toLowerCase()
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

/** Does this instance carry answers under child names the schema no longer
 *  has? See `orphanedNodes` — the nested counterpart of the same rule. */
function holdsOrphans(def: ResolvedDef, inst: InstanceNode): boolean {
  return Object.keys(orphanedNodes(def.children, inst.children)).length > 0
}

/**
 * Does `tree` hold, at any depth, answers the current schema no longer
 * describes? The whole-tree form of `orphanedNodes`: a top-level key with no
 * def, or a node that lost the children its answers sit under.
 *
 * What decides whether a file is still worth writing — `hasAnnotations` asks
 * only about the current schema, and on its own would drop the very file the
 * orphans live in.
 */
export function treeHoldsOrphans(defs: ResolvedDef[], tree: AnnotationValueTree): boolean {
  if (Object.keys(orphanedNodes(defs, tree)).length > 0) return true
  for (const def of defs) {
    for (const inst of tree[def.name] ?? []) {
      if (holdsOrphans(def, inst)) return true
      if (def.children.length > 0 && inst?.children && treeHoldsOrphans(def.children, inst.children)) {
        return true
      }
    }
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
