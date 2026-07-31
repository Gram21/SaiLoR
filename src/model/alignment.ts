import { makeInstance, type AnnotationValueTree, type InstanceNode } from './annotations'
import { isField, type ResolvedDef } from './schema'

/**
 * Which of each reviewer's repeated entries are *the same entry*, recorded
 * explicitly instead of by reordering their data.
 *
 * Until v1.7 the correspondence was stored as the ordering itself: every
 * reviewer's entries were physically permuted so that index N meant the same
 * entry for everyone (see `consolidate/apply.ts`). That made every
 * cross-reviewer read a plain fixed-index lookup, but it paid for it in the
 * reviewers' own data — a reviewer who recorded one finding everyone else
 * listed third had their list rewritten to `[empty, empty, theirs]`, which
 * they then saw as two blank entries above their answer, which dragged their
 * completeness dot down, and which Validate reported as two missing required
 * fields. Consolidation's bookkeeping was being written into other people's
 * work.
 *
 * Now the mapping is its own record and the reviewers' arrays are never
 * touched. Anything that needs to read across reviewers projects them through
 * `alignedReviews` first, which produces the same lined-up view as a throwaway
 * copy.
 *
 * Persisted (in the consolidated annotations file) rather than recomputed on
 * demand, for the same reason the ordering used to be: matching is offered
 * *before* the consolidator starts work, and once they have committed an
 * answer under a node, slot N means a particular thing to them. A mapping
 * recomputed after a reviewer's later edit could quietly move a different
 * entry into slot N, and their recorded answer would then describe something
 * it was never about.
 */

/** One consolidated entry: who contributed it, and their own index for it. */
export interface StoredSlot {
  /** Reviewer id → the index of their entry in their *own*, unmodified array. */
  members: Record<string, number>
  /** Mappings for this slot's repeated children, matched within this pair. */
  children?: StoredAlignment
}

/** Node name → its slots, for one level of the tree. */
export type StoredAlignment = Record<string, StoredSlot[]>

/**
 * Parse `alignment` defensively, the same rule `equal`/`reviews`/`aiUsage`
 * follow: the file is hand-editable, so anything malformed is dropped rather
 * than thrown over. A dropped mapping is not data loss — the reviewers' own
 * answers are untouched by definition, and reopening Consolidation recomputes
 * it.
 *
 * Indices must be non-negative integers; a fractional or negative one would
 * silently read as "this reviewer has no entry here" later, which is a
 * different claim than the file was trying to make.
 */
export function parseAlignment(raw: unknown): StoredAlignment {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: StoredAlignment = {}
  for (const [name, slots] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(slots)) continue
    const parsed = slots.map((slot) => parseSlot(slot))
    if (parsed.length > 0) out[name] = parsed
  }
  return out
}

function parseSlot(raw: unknown): StoredSlot {
  if (typeof raw !== 'object' || raw === null) return { members: {} }
  const r = raw as { members?: unknown; children?: unknown }
  const members: Record<string, number> = {}
  if (typeof r.members === 'object' && r.members !== null && !Array.isArray(r.members)) {
    for (const [reviewer, index] of Object.entries(r.members as Record<string, unknown>)) {
      if (typeof index === 'number' && Number.isInteger(index) && index >= 0) members[reviewer] = index
    }
  }
  const children = parseAlignment(r.children)
  return Object.keys(children).length > 0 ? { members, children } : { members }
}

/** The project JSON is hand-editable, so a node may hold something else. */
function asList(raw: unknown): InstanceNode[] {
  return Array.isArray(raw) ? (raw as InstanceNode[]) : []
}

/**
 * Each reviewer's tree as seen *through* the mapping: a throwaway copy in
 * which index N is the same entry for every reviewer, so a cross-reviewer
 * reader can go on comparing at a fixed index.
 *
 * A slot no reviewer filled becomes an empty instance for them — the honest
 * rendering of "they have nothing for this one", and what makes
 * `isUnanswered`/`agreedValue` treat it as silence rather than an answer. An
 * entry the mapping has no slot for (a node whose mapping is stale because
 * that reviewer added an entry after the consolidator started) is appended
 * rather than dropped, so nothing a reviewer wrote can go missing from a view
 * built on a mapping that has fallen behind.
 *
 * A node with no mapping at all — nobody has opened Consolidation on this
 * paper yet, or it is not a repeatable node — passes through in its own
 * order, which is exactly the pre-alignment behavior.
 *
 * Read-only in spirit: nothing here is written back, and callers must not
 * write through it. The reviewers' stored trees are the authority.
 */
export function alignedReviews(
  defs: ResolvedDef[],
  alignment: StoredAlignment,
  reviews: Record<string, AnnotationValueTree | undefined>,
): Record<string, AnnotationValueTree> {
  const out: Record<string, AnnotationValueTree> = {}
  for (const reviewer of Object.keys(reviews)) {
    out[reviewer] = projectLevel(defs, alignment, reviews[reviewer], reviewer)
  }
  return out
}

function projectLevel(
  defs: ResolvedDef[],
  alignment: StoredAlignment,
  tree: AnnotationValueTree | undefined,
  reviewer: string,
): AnnotationValueTree {
  const out: AnnotationValueTree = {}
  for (const def of defs) {
    const source = asList(tree?.[def.name])
    const slots = alignment[def.name]

    if (!slots) {
      out[def.name] = source.map((inst) => projectInstance(def, undefined, inst, reviewer))
      continue
    }

    const projected = slots.map((slot) => {
      const index = slot.members[reviewer]
      return projectInstance(def, slot.children, index === undefined ? undefined : source[index], reviewer)
    })
    for (let i = 0; i < source.length; i++) {
      if (!slots.some((slot) => slot.members[reviewer] === i)) {
        projected.push(projectInstance(def, undefined, source[i], reviewer))
      }
    }
    out[def.name] = projected
  }
  return out
}

function projectInstance(
  def: ResolvedDef,
  children: StoredAlignment | undefined,
  inst: InstanceNode | undefined,
  reviewer: string,
): InstanceNode {
  if (!inst) return makeInstance(def)
  // Same shape `makeInstance` builds — `value` only on an actual field, so a
  // pure group does not sprout a null value the rest of the code never expects.
  const out: InstanceNode = {}
  if (isField(def)) out.value = inst.value ?? null
  if (def.children.length > 0) {
    out.children = projectLevel(def.children, children ?? {}, inst.children, reviewer)
  }
  return out
}
