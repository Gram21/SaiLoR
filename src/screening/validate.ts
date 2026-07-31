import type { AnnotationValueTree } from '../model/annotations'
import type { Paper, Project } from '../model/project'
import type { ValidationIssue } from '../model/validate'
import { SCREENING_REASON } from './schema'
import { screeningReason, screeningStatus } from './status'

/** Mirrors `currentTree`'s seat routing — see `screening/counts.ts`'s `seatTree`
 *  for why this is reimplemented rather than imported. */
function seatTree(
  project: Project,
  currentReviewer: string | null,
  paper: Paper,
): AnnotationValueTree | null {
  if (project.reviewers <= 1) return paper.annotations
  if (currentReviewer === 'consolidation') return paper.annotations
  if (currentReviewer === null) return null
  return paper.reviews[currentReviewer] ?? null
}

/**
 * The two cross-field rules the schema language cannot express. The screening
 * UI makes both unreachable (the Reason control disables itself unless the
 * decision is Exclude, and clears on any other decision — see
 * `setScreeningDecision`), but a hand-edited file can still hold either, and
 * both corrupt the PRISMA counts silently if nobody says so.
 */
export function screeningIssues(project: Project, currentReviewer: string | null): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const paper of project.papers) {
    const tree = seatTree(project, currentReviewer, paper)
    if (!tree) continue
    const status = screeningStatus(tree)
    const reason = screeningReason(tree)
    if (status === 'excluded' && !reason) {
      issues.push({
        paperId: paper.id,
        paperTitle: paper.title,
        path: SCREENING_REASON,
        // Screening has no annotation-panel field to jump to (its schema is
        // derived from the reasons list, not authored) — ValidationDialog
        // falls back to a paper-only jump when this is empty.
        canonicalPath: '',
        kind: 'screening',
        message: 'Excluded, but no exclusion reason is recorded.',
      })
    } else if (status !== 'excluded' && reason) {
      issues.push({
        paperId: paper.id,
        paperTitle: paper.title,
        path: SCREENING_REASON,
        // Screening has no annotation-panel field to jump to (its schema is
        // derived from the reasons list, not authored) — ValidationDialog
        // falls back to a paper-only jump when this is empty.
        canonicalPath: '',
        kind: 'screening',
        message: 'An exclusion reason is recorded, but this paper is not excluded.',
      })
    }
  }
  return issues
}
