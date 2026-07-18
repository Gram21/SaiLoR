import type { AnnotationValueTree, InstanceNode } from './annotations'

/**
 * Answers are stored keyed by the schema field's *name*, so renaming a field in
 * the project editor — or removing one — orphans every answer recorded under
 * the old name. Nothing migrates them: `normalizeTree` builds its output by
 * iterating the schema's defs and drops any key the schema no longer has, so
 * the next load quietly prunes them and the next save makes that permanent.
 *
 * This module answers the one question the schema editor needs in order to warn
 * first: how many papers still record an answer under a given field name. It is
 * the counterpart of `screening/reasonUsage.ts`, which guards the exactly
 * analogous rename in the screening reasons editor — the two hazards are the
 * same shape, and this closes the half that had no guard.
 *
 * Matching is by name at **any depth**, not by a resolved path. Sibling names
 * are unique but the same name may legitimately appear at two levels, so this
 * can over-count — deliberately, because the operation it guards is
 * unrecoverable and a spurious confirmation costs a click while a missed one
 * costs a reviewer's work.
 */
export interface AnswerBearingPaper {
  annotations?: unknown
  extra?: Record<string, unknown>
}

function asTree(value: unknown): AnnotationValueTree | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnnotationValueTree)
    : null
}

/** Every annotation tree a paper carries: the consolidated one plus each
 *  reviewer's own (the editor keeps `reviews` verbatim under `extra`). */
function treesOf(paper: AnswerBearingPaper): AnnotationValueTree[] {
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

/**
 * Is this a real recorded answer? Mirrors the rule the rest of the app uses:
 * an unticked checkbox is not evidence of anything (every boolean reads `false`
 * whether or not anyone looked), and a blank or whitespace-only string is not
 * an answer either — so neither should make a rename look destructive when it
 * is not.
 */
function isAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'number') return Number.isFinite(value)
  return false
}

/** Does this instance, or anything nested beneath it, hold a recorded answer? */
function instanceHasAnswer(inst: unknown): boolean {
  if (!inst || typeof inst !== 'object') return false
  const node = inst as InstanceNode
  if (isAnswer(node.value)) return true
  const children = asTree(node.children)
  if (!children) return false
  for (const list of Object.values(children)) {
    if (Array.isArray(list) && list.some(instanceHasAnswer)) return true
  }
  return false
}

/** Does `tree` hold an answer under a node named `name`, at any depth? */
function treeUsesName(tree: AnnotationValueTree, name: string): boolean {
  for (const [key, list] of Object.entries(tree)) {
    if (!Array.isArray(list)) continue
    if (key === name && list.some(instanceHasAnswer)) return true
    // Not this node — look inside its instances' children for one that is.
    for (const inst of list) {
      if (!inst || typeof inst !== 'object') continue
      const children = asTree((inst as InstanceNode).children)
      if (children && treeUsesName(children, name)) return true
    }
  }
  return false
}

/**
 * How many of these papers record an answer under a field named `name`, across
 * their consolidated tree and every reviewer's own. `''` never matches — a
 * blank name is not a field anyone has answered.
 */
export function countPapersUsingField(papers: AnswerBearingPaper[], name: string): number {
  if (name.trim() === '') return 0
  return papers.filter((p) => treesOf(p).some((t) => treeUsesName(t, name))).length
}
