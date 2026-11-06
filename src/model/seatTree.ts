import type { AnnotationValueTree } from './annotations'
import type { Paper, Project } from './project'

/**
 * The tree a seat reads for `paper`, read-only and store-free: single-reviewer
 * or Consolidation → `paper.annotations`; a numbered reviewer → their stored
 * tree, or `null` if none yet; nobody selected in a multi-reviewer project → `null`.
 * `currentTree` in `state/store.ts` builds on this.
 */
export function seatTree(
  project: Pick<Project, 'reviewers'>,
  currentReviewer: string | null,
  paper: Paper,
): AnnotationValueTree | null {
  if (project.reviewers <= 1) return paper.annotations
  if (currentReviewer === 'consolidation') return paper.annotations
  if (currentReviewer === null) return null
  return paper.reviews[currentReviewer] ?? null
}
