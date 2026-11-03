import type { ResolvedDef } from './schema'
import { t } from '../i18n'
import {
  isRecordedAnswer,
  makeInstance,
  type AnnotationValueTree,
  type FieldValue,
  type InstanceNode,
} from './annotations'
import { MAX_UNBOUNDED_INDEX, resolvePath, type RawSeg } from '../llm/paths'

function valueKey(def: ResolvedDef, value: unknown): string | null {
  if (!isRecordedAnswer(value)) return null
  if (typeof value === 'string' && !(def.options && def.options.length > 0)) {
    return JSON.stringify(value.trim().replace(/\s+/g, ' ').toLowerCase())
  }
  return JSON.stringify(value)
}

function treeKey(defs: ResolvedDef[], tree: AnnotationValueTree | undefined): string | null {
  const parts: string[] = []
  for (const def of defs) {
    const keys = (tree?.[def.name] ?? [])
      .map((inst) => subtreeKey(def, inst))
      .filter((k) => k !== null)
    if (keys.length > 0) parts.push(`${JSON.stringify(def.name)}:[${keys.join(',')}]`)
  }
  return parts.length > 0 ? `{${parts.join(',')}}` : null
}

function subtreeKey(def: ResolvedDef, inst: InstanceNode | undefined): string | null {
  const own = valueKey(def, inst?.value)
  const kids = def.children.length > 0 ? treeKey(def.children, inst?.children) : null
  if (own === null && kids === null) return null
  return `${own ?? ''}|${kids ?? ''}`
}

// [impl->req~dat-400~1]
/** The comparison key of one entry of a `unique` node; null when the entry holds no answer. */
export function entryKey(def: ResolvedDef, inst: InstanceNode | undefined): string | null {
  const names = def.uniqueBy
  if (!names) return subtreeKey(def, inst)
  return treeKey(
    def.children.filter((c) => names.includes(c.name)),
    inst?.children,
  )
}

// [impl->req~dat-400~1]
/** For each entry that repeats an earlier one: [its index, index of the earlier entry]. */
export function duplicateIndexes(def: ResolvedDef, list: InstanceNode[]): Array<[number, number]> {
  const first = new Map<string, number>()
  const out: Array<[number, number]> = []
  list.forEach((inst, i) => {
    const key = entryKey(def, inst)
    if (key === null) return
    const earlier = first.get(key)
    if (earlier === undefined) first.set(key, i)
    else out.push([i, earlier])
  })
  return out
}

function writeInto(
  defs: ResolvedDef[],
  tree: AnnotationValueTree,
  segs: RawSeg[],
  value: FieldValue,
): boolean {
  let level = defs
  let container = tree
  for (let i = 0; i < segs.length; i++) {
    const def = level.find((d) => d.name === segs[i].name)
    if (!def) return false
    if (segs[i].index >= (def.max === null ? MAX_UNBOUNDED_INDEX : def.max)) return false
    if (!Array.isArray(container[def.name])) container[def.name] = []
    const list = container[def.name]
    while (list.length <= segs[i].index) list.push(makeInstance(def))
    const inst = list[segs[i].index]
    if (i === segs.length - 1) {
      inst.value = value
      return true
    }
    inst.children ??= {}
    container = inst.children
    level = def.children
  }
  return false
}

// [impl->req~dat-410~1]
/**
 * The hint to show when writing `value` at `segs` would make an entry of a
 * `unique` node equal to another entry; null when the write is allowed. An
 * entry that already repeats another one does not block an unrelated edit.
 */
export function duplicateOnWrite(
  defs: ResolvedDef[],
  tree: AnnotationValueTree,
  segs: RawSeg[],
  value: FieldValue,
): string | null {
  const chain: ResolvedDef[] = []
  let level = defs
  for (const seg of segs) {
    const def = level.find((d) => d.name === seg.name)
    if (!def) return null
    chain.push(def)
    level = def.children
  }
  if (!chain.some((d) => d.unique)) return null

  const after = structuredClone(tree)
  if (!writeInto(defs, after, segs, value)) return null
  let before: AnnotationValueTree | undefined = tree
  let now: AnnotationValueTree | undefined = after
  for (let i = 0; i < segs.length; i++) {
    const def = chain[i]
    const { index } = segs[i]
    const oldList: InstanceNode[] = before?.[def.name] ?? []
    const newList: InstanceNode[] = now?.[def.name] ?? []
    if (def.unique) {
      const key = entryKey(def, newList[index])
      if (key !== null && key !== entryKey(def, oldList[index])) {
        const other = newList.findIndex((inst, j) => j !== index && entryKey(def, inst) === key)
        if (other >= 0)
          return t('store.unique.duplicate', { name: def.name.trim(), n: other + 1 })
      }
    }
    before = oldList[index]?.children
    now = newList[index]?.children
  }
  return null
}

// [impl->req~dat-410~1]
/**
 * Split suggested values into the ones that keep every `unique` node free of
 * repeats (applied in order to a copy of `tree`) and the ones that would not.
 */
export function dropDuplicateSuggestions<T extends { path: string; value: FieldValue }>(
  defs: ResolvedDef[],
  tree: AnnotationValueTree,
  suggestions: T[],
): { kept: T[]; dropped: Array<{ suggestion: T; reason: string }> } {
  const work = structuredClone(tree)
  const kept: T[] = []
  const dropped: Array<{ suggestion: T; reason: string }> = []
  for (const s of suggestions) {
    const target = resolvePath(defs, s.path, { maxUnboundedIndex: MAX_UNBOUNDED_INDEX })
    if (!target) {
      kept.push(s)
      continue
    }
    const segs = [...target.path, { name: target.name, index: target.index }]
    const reason = duplicateOnWrite(defs, work, segs, s.value)
    if (reason) {
      dropped.push({ suggestion: s, reason })
      continue
    }
    writeInto(defs, work, segs, s.value)
    kept.push(s)
  }
  return { kept, dropped }
}
