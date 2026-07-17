import type { AnnotationValueTree, InstanceNode } from '../model/annotations'
import { SCREENING_REASON } from './schema'

/**
 * Renaming a screening exclusion reason in the project editor leaves every
 * paper that recorded the old label pointing at a reason that no longer
 * exists — orphaning its exclusion, which the PRISMA-style counts then can't
 * attribute (it lands in `excludedWithoutReason`). This module answers the two
 * questions the reasons editor needs to guard that rename: how many papers use
 * a reason, and rewrite it across all of them.
 *
 * A paper carries a reason in more than one place once a project is
 * multi-reviewer: its consolidated `annotations` tree (what ships) and each
 * reviewer's own tree. The editor doesn't model `reviews` directly — it keeps
 * them verbatim in a paper's `extra` — so both are checked here from the raw
 * shape rather than the typed `Paper`.
 */
export interface ReasonBearingPaper {
  annotations?: unknown
  extra?: Record<string, unknown>
}

function asTree(value: unknown): AnnotationValueTree | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnnotationValueTree) : null
}

/** Every screening tree a paper carries — its consolidated one, plus each
 *  reviewer's own (kept under `extra.reviews` in the editor's representation). */
function treesOf(paper: ReasonBearingPaper): AnnotationValueTree[] {
  const trees: AnnotationValueTree[] = []
  const consolidated = asTree(paper.annotations)
  if (consolidated) trees.push(consolidated)
  const reviews = asTree(paper.extra?.reviews)
  if (reviews) {
    for (const v of Object.values(reviews)) {
      const t = asTree(v)
      if (t) trees.push(t)
    }
  }
  return trees
}

function reasonOf(tree: AnnotationValueTree): string | null {
  const inst = tree[SCREENING_REASON]?.[0]
  const value = inst && typeof inst === 'object' ? (inst as InstanceNode).value : undefined
  return typeof value === 'string' && value !== '' ? value : null
}

/** How many of these papers record `reason` as an exclusion reason, in any of
 *  their screening trees. `''` never matches — an unset reason is not "using"
 *  anything, so renaming away from a blank reason never triggers the guard. */
export function countPapersUsingReason(papers: ReasonBearingPaper[], reason: string): number {
  if (reason === '') return 0
  return papers.filter((p) => treesOf(p).some((t) => reasonOf(t) === reason)).length
}

/** Rewrite one tree's `Reason` value from `from` to `to`, immutably. Returns
 *  the same tree object (unchanged identity) when it doesn't hold `from`, so a
 *  caller can tell whether anything actually moved. */
function rewriteTree(tree: AnnotationValueTree, from: string, to: string): AnnotationValueTree {
  const arr = tree[SCREENING_REASON]
  if (!Array.isArray(arr) || arr.length === 0) return tree
  const inst = arr[0]
  if (!inst || typeof inst !== 'object' || (inst as InstanceNode).value !== from) return tree
  const nextArr = [{ ...inst, value: to }, ...arr.slice(1)]
  return { ...tree, [SCREENING_REASON]: nextArr }
}

/**
 * Rewrite `from` → `to` in every screening tree of every paper. Papers (and
 * trees) that don't reference `from` keep their identity, so the caller's
 * dirty-tracking only marks what actually changed. Generic over the paper
 * shape so the editor keeps its `EditorPaper` type through the call.
 */
export function renameReasonInPapers<T extends ReasonBearingPaper>(papers: T[], from: string, to: string): T[] {
  if (from === '' || from === to) return papers
  let anyChanged = false
  const next = papers.map((paper) => {
    let changed = false

    const consolidated = asTree(paper.annotations)
    let nextAnnotations = paper.annotations
    if (consolidated) {
      const rewritten = rewriteTree(consolidated, from, to)
      if (rewritten !== consolidated) {
        nextAnnotations = rewritten
        changed = true
      }
    }

    let nextExtra = paper.extra
    const reviews = asTree(paper.extra?.reviews)
    if (reviews) {
      let reviewsChanged = false
      const nextReviews: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(reviews)) {
        const t = asTree(v)
        if (t) {
          const rewritten = rewriteTree(t, from, to)
          if (rewritten !== t) reviewsChanged = true
          nextReviews[k] = rewritten
        } else {
          nextReviews[k] = v
        }
      }
      if (reviewsChanged) {
        nextExtra = { ...paper.extra, reviews: nextReviews }
        changed = true
      }
    }

    if (!changed) return paper
    anyChanged = true
    return { ...paper, annotations: nextAnnotations, extra: nextExtra }
  })
  // Whole-array identity is preserved when nothing referenced the reason, so a
  // caller (and its dirty-tracking) can trust `=== papers` to mean "no-op".
  return anyChanged ? next : papers
}
