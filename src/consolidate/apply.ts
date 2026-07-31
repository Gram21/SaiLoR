import { makeInstance, type AnnotationValueTree, type InstanceNode } from '../model/annotations'
import type { ResolvedDef } from '../model/schema'
import { isRepeatable, type TreeAlignment } from './align'
import type { PathSeg } from '../state/store'

/**
 * Write an alignment into the data, which is how it is remembered.
 *
 * There is no "mapping" field in the saved file. Instead the mapping *is* the
 * ordering: every reviewer's entries are laid out so that position N means the
 * same entry for everyone, and the consolidated tree is grown to match. So
 * "Finding #3" names one finding across the whole project, the compare popup can
 * read straight across at a fixed index, and the correspondence survives a save
 * and reload with no extra schema and no file-format change.
 *
 * The cost is that a reviewer's own list can gain gaps — if Reviewer 1 recorded
 * only the finding everyone else listed third, theirs becomes #3, with #1 and #2
 * empty. That is the honest rendering: they have nothing for those two. It also
 * relies on `pruneTree` keeping interior gaps, which is why that function only
 * drops *trailing* empties.
 *
 * Mutates in place, the way the store's immer drafts expect, and reports whether
 * anything actually moved — opening a window must not mark a project dirty when
 * the data already agreed with the alignment.
 */
export function applyAlignment(
  schema: ResolvedDef[],
  alignment: TreeAlignment,
  reviews: Record<string, AnnotationValueTree>,
  consolidated: AnnotationValueTree,
): boolean {
  return applyLevel(schema, alignment, reviews, consolidated)
}

/**
 * Rewrite one reviewer's canonical path after `applyAlignment` has permuted
 * their repeatable entries into the shared slot order — the permutation
 * counterpart to `shiftCanonicalPath` in `store.ts` (that one handles a
 * removal shifting indices down; this one handles a whole-array reorder).
 * Without it, a mark linked to "Findings #1" keeps naming index 0 even after
 * alignment moved that reviewer's first entry into slot 2 — the link (and
 * any AI mark) would silently point at whatever now sits in the old slot.
 *
 * Walks `segs` left to right against the alignment, translating each
 * reviewer-local index into its slot index. The first segment the alignment
 * has no node for — most commonly a path's trailing leaf field, since
 * `alignLevel` never creates a node for a childless non-repeatable def — ends
 * the walk: that segment and everything after it are appended unchanged. A
 * whole-path bail on the first miss would silently no-op the entire rewrite,
 * because every real path's leaf lands here.
 *
 * An entry left stranded past `clampToMax` in `applyLevel` ("should not
 * arise", apply.ts) has no slot and is deliberately not remapped either —
 * it falls out through the same unmatched-segment path.
 */
export function remapAlignedPath(
  alignment: TreeAlignment,
  reviewer: string,
  segs: PathSeg[],
): PathSeg[] {
  const out: PathSeg[] = []
  let level = alignment
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const node = level[seg.name]
    const s = node?.slots.findIndex((slot) => slot.members[reviewer] === seg.index) ?? -1
    if (!node || s === -1) return [...out, ...segs.slice(i)]
    out.push({ name: seg.name, index: s })
    level = node.slots[s].children
  }
  return out
}

function applyLevel(
  defs: ResolvedDef[],
  alignment: TreeAlignment,
  reviews: Record<string, AnnotationValueTree | undefined>,
  consolidated: AnnotationValueTree | undefined,
): boolean {
  let changed = false

  for (const def of defs) {
    const node = alignment[def.name]
    if (!node) continue

    if (isRepeatable(def)) {
      const slotCount = clampToMax(def, node.slots.length)

      for (const [reviewer, tree] of Object.entries(reviews)) {
        if (!tree) continue
        const before = asList(tree[def.name])
        const after: InstanceNode[] = []
        for (let s = 0; s < slotCount; s++) {
          const index = node.slots[s]?.members[reviewer]
          after.push(index === undefined ? makeInstance(def) : before[index] ?? makeInstance(def))
        }
        // An entry the alignment found no slot for would otherwise be dropped —
        // silent data loss. Slots are sized to the largest list so this should
        // not arise, but a `max` that shrank under existing data could do it.
        for (let i = 0; i < before.length; i++) {
          if (!node.slots.some((s) => s.members[reviewer] === i)) after.push(before[i])
        }
        if (!sameOrder(before, after)) changed = true
        tree[def.name] = after
      }

      if (consolidated && growConsolidated(def, consolidated, slotCount)) changed = true
    }

    // Recurse *inside* each slot. After the rewrite above, slot N is index N in
    // every reviewer's list, so the children line up by position too.
    for (let s = 0; s < node.slots.length; s++) {
      const slot = node.slots[s]
      const childReviews: Record<string, AnnotationValueTree | undefined> = {}
      for (const [reviewer, tree] of Object.entries(reviews)) {
        const index = isRepeatable(def) ? s : (slot.members[reviewer] ?? 0)
        childReviews[reviewer] = tree?.[def.name]?.[index]?.children
      }
      const childConsolidated = consolidated?.[def.name]?.[s]?.children
      if (applyLevel(def.children, slot.children, childReviews, childConsolidated)) changed = true
    }
  }

  return changed
}

/**
 * Give the consolidated tree one entry per slot — the feature's rule that the
 * consolidator should find the entries already laid out rather than having to
 * count the reviewers' work by hand and press "add" that many times.
 *
 * Only ever grows. The consolidator may have added entries of their own, and a
 * count derived from the reviewers is no reason to delete them.
 */
function growConsolidated(
  def: ResolvedDef,
  consolidated: AnnotationValueTree,
  slotCount: number,
): boolean {
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

/** Identity-based: a rewrite that reuses every entry in place changed nothing. */
function sameOrder(before: InstanceNode[], after: InstanceNode[]): boolean {
  return before.length === after.length && before.every((inst, i) => inst === after[i])
}
