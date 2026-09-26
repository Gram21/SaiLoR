import { useStore, selectCurrentPaper } from '../state/store'
import { useGitStore } from '../state/gitStore'
import { seatTakenByOther, ownerLabel } from '../git/seatOwner'

/**
 * "Somebody has already read this paper in the seat you are sitting in."
 *
 * The one collision a multi-reviewer review cannot absorb. Two people in the
 * same seat on the same paper write the same
 * `annotations/<paperId>/reviewer-N.json`; whoever merges last overwrites or
 * field-merges away the other's answers, and the two "independent" readings
 * the review is built on turn out to be one.
 *
 * Per paper, not per seat, because a seat is not a person — see
 * `src/git/seatOwner.ts`. In a review of any size the papers are divided among
 * many more people than there are seats, so the same seat is legitimately held
 * by a different reviewer on every paper, and a project-wide "who owns seat 1"
 * warning would fire on almost every paper a reviewer is supposed to be doing.
 * A guard that wrong is worse than none: it teaches people to ignore it.
 *
 * Informational, never blocking. Working on somebody else's paper is sometimes
 * exactly what is wanted — a second pass, a handover, a correction — and only
 * the reviewer knows which case this is. It reports what git already recorded
 * and leaves the judgement where it belongs.
 */
export function SeatConflictNotice() {
  const paper = useStore(selectCurrentPaper)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const screening = !!useStore((s) => s.project?.screening)
  const authors = useGitStore((s) => s.annotationAuthors)

  if (!paper || !currentReviewer) return null
  const other = seatTakenByOther(authors, paper.id, currentReviewer, screening)
  if (!other) return null

  const seat = currentReviewer === 'consolidation' ? 'Consolidation' : `Reviewer ${currentReviewer}`

  return (
    <p className="seat-conflict-notice" role="status">
      <strong>{ownerLabel(other)}</strong> has already committed {seat} for this paper. If that was
      not meant to be you, switch seats or pick another paper — two people in one seat write the
      same file, and whoever merges last replaces the other's answers.
    </p>
  )
}
