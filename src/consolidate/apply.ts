import { makeInstance, type AnnotationValueTree, type InstanceNode } from '../model/annotations'
import type { ResolvedDef } from '../model/schema'
import type { StoredAlignment, StoredSlot } from '../model/alignment'
import { isRepeatable, type TreeAlignment } from './align'

/**
 * Record an alignment, and grow the consolidated tree to fit it.
 *
 * The alignment used to be written into the data *as the ordering*: every
 * reviewer's entries were permuted so position N meant the same entry for
 * everyone. That is no longer how it is remembered — see `model/alignment.ts`
 * for why, and `alignedReviews` there for what replaced it. Reviewers' own
 * trees are now never touched by consolidation, and this module only does the
 * two things that remain: turn the computed alignment into its stored form,
 * and give the consolidated tree one entry per slot so the consolidator finds
 * the entries already laid out instead of counting the reviewers' work by hand
 * and pressing "add" that many times.
 */

/**
 * The persistable half of a computed alignment: who is in each slot, and
 * nothing else. `agreement`/`evidence` are re-derived from the answers
 * whenever they are wanted, and `counts` is just each reviewer's array length
 * — storing either would be storing a claim that can go stale against the
 * data it describes.
 */
export function toStoredAlignment(alignment: TreeAlignment): StoredAlignment {
  const out: StoredAlignment = {}
  for (const [name, node] of Object.entries(alignment)) {
    out[name] = node.slots.map((slot) => {
      const stored: StoredSlot = { members: { ...slot.members } }
      const children = toStoredAlignment(slot.children)
      if (Object.keys(children).length > 0) stored.children = children
      return stored
    })
  }
  return out
}

/**
 * Give the consolidated tree one entry per slot.
 *
 * Only ever grows. The consolidator may have added entries of their own, and a
 * count derived from the reviewers is no reason to delete them.
 *
 * Mutates in place, the way the store's immer drafts expect, and reports
 * whether anything actually moved — opening a window must not mark a project
 * dirty when the data already fitted.
 */
export function growConsolidated(
  defs: ResolvedDef[],
  alignment: TreeAlignment,
  consolidated: AnnotationValueTree | undefined,
): boolean {
  if (!consolidated) return false
  let changed = false

  for (const def of defs) {
    const node = alignment[def.name]
    if (!node) continue

    if (isRepeatable(def) && growList(def, consolidated, node.slots.length)) changed = true

    // Recurse inside each slot: a repeatable node nested under this one is
    // matched within its own parent pair, so its slot count is per-entry.
    for (let s = 0; s < node.slots.length; s++) {
      const childTree = consolidated[def.name]?.[s]?.children
      if (childTree && growConsolidated(def.children, node.slots[s].children, childTree)) changed = true
    }
  }

  return changed
}

function growList(def: ResolvedDef, consolidated: AnnotationValueTree, slotCount: number): boolean {
  const list = asList(consolidated[def.name])
  const target = clampToMax(def, Math.max(slotCount, list.length, Math.max(def.min, 1)))
  if (list.length >= target) {
    consolidated[def.name] = list
    return false
  }
  while (list.length < target) list.push(makeInstance(def))
  consolidated[def.name] = list
  return true
}

function clampToMax(def: ResolvedDef, count: number): number {
  return def.max === null ? count : Math.min(count, def.max)
}

/** The project JSON is hand-editable, so a node may hold something else. */
function asList(raw: unknown): InstanceNode[] {
  return Array.isArray(raw) ? (raw as InstanceNode[]) : []
}
