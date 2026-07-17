import { useStore } from '../state/store'
import { useGitStore } from '../state/gitStore'
import { readyCount } from '../consolidate/readiness'
import { checkSeat, describeIdentity, seatLabel, toReviewerIdentity } from '../model/identity'

/**
 * Shown when a multi-reviewer project is opened and nobody has picked a seat —
 * which, because the choice is persisted per project, means the first time this
 * file is opened on this machine. Also shown, in a second mode, when the seat
 * that *is* picked was recorded (in the file, `config.reviewerIdentities`) as
 * someone else's — see `checkSeat` for exactly which combination of "who
 * claimed it" and "who does this machine think I am" that fires on, and why it
 * deliberately does not fire when this machine has no git identity to compare.
 *
 * Until now that state was a single line where the annotation form should be.
 * It said what to do but not why any of it exists, and the whole point of a
 * multi-reviewer file — that reviewers work *independently*, that you will not
 * see anyone else's answers, that a separate pass reconciles them — is exactly
 * the thing a reviewer needs to know before they start rather than after.
 *
 * There is deliberately no way out but choosing, in both modes. The choose
 * screen withholds the form without a seat anyway, so a dismiss button would
 * only offer a state in which nothing can be done; the choice is free,
 * reversible from the toolbar, and costs nothing to change later. The mismatch
 * screen offers two real ways forward — take the seat, or pick another — never
 * a plain "ignore this", because clicking through an unresolved same-seat
 * claim is exactly how the fabricated-opinion hazard this exists to catch
 * gets built (see `src/model/identity.ts`'s module doc).
 */
export function ReviewerPrompt() {
  const project = useStore((s) => s.project)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const selectReviewer = useStore((s) => s.selectReviewer)
  const takeSeat = useStore((s) => s.takeSeat)
  const helpOpen = useStore((s) => s.helpOpen)
  const gitIdentity = useGitStore((s) => s.identity)

  if (!project || project.reviewers <= 1) return null
  // Yield to Help. Nothing else can be reached while this is up, so F1 is the
  // one way to go and read more before committing to a seat — and it would be
  // perverse for the prompt explaining multi-review to be what stops you.
  if (helpOpen) return null

  const me = toReviewerIdentity(gitIdentity?.email, gitIdentity?.name)
  const hasClaims = Object.keys(project.reviewerIdentities).length > 0

  if (currentReviewer !== null) {
    const verdict = checkSeat(project.reviewerIdentities, currentReviewer, me?.email ?? null)
    if (verdict.kind === 'ok') return null
    return (
      <div className="modal-overlay">
        <div className="modal reviewer-prompt reviewer-mismatch" role="dialog" aria-modal="true">
          <div className="modal-head">
            <strong>This seat is someone else's</strong>
          </div>
          <div className="modal-body">
            <p>
              {seatLabel(currentReviewer)} is recorded as <strong>{describeIdentity(verdict.holder)}</strong>{' '}
              in this project file — not you. If you both annotate here, your answers land in the same
              seat and cannot be told apart afterward; a git merge will not raise a conflict about it,
              it will simply blend the two of you into one opinion.
            </p>
            <p>
              Only take this seat if you are certain {describeIdentity(verdict.holder)} is not also using it —
              agree that in person or over email first if you are not sure.
            </p>
            <div className="reviewer-mismatch-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  if (me) takeSeat(currentReviewer, me)
                }}
                disabled={!me}
                title={me ? undefined : 'No git identity is available on this machine to claim it with.'}
              >
                Take this seat
              </button>
              <button type="button" onClick={() => selectReviewer(null)}>
                Pick a different seat
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const reviewerIds = Array.from({ length: project.reviewers }, (_, i) => String(i + 1))
  const ready = readyCount(project.schema, project.papers, project.reviewers)
  const total = project.papers.length

  return (
    <div className="modal-overlay">
      <div className="modal reviewer-prompt" role="dialog" aria-modal="true">
        <div className="modal-head">
          <strong>This review has {project.reviewers} reviewers</strong>
        </div>
        <div className="modal-body">
          <p>
            Every paper here is annotated <strong>independently</strong> by {project.reviewers}{' '}
            people. You will see and edit <strong>only your own</strong> answers — not anyone else's.
            That is the point: an SLR's reviewers are meant to reach their findings separately, so
            that where they agree means something.
          </p>
          <p>
            <strong>Seats are agreed across everyone's clones, not just this machine.</strong> If two
            people both pick "Reviewer 1" on their own copies, their answers merge into one — there is
            no warning for it unless the project file already records who holds which seat. Pick the
            seat that is actually yours.
          </p>
          <p>
            <strong>Consolidation</strong> is the pass that comes after. Whoever takes that seat sees
            everyone's answers side by side, settles the disagreements, and records the project's
            final result. It is not another opinion — it is the reconciliation of the others.
          </p>
          <p className="reviewer-prompt-ask">Which are you?</p>
          <div className="reviewer-prompt-choices">
            {reviewerIds.map((id) => {
              const holder = project.reviewerIdentities[id]
              return (
                <button
                  key={id}
                  type="button"
                  className="reviewer-prompt-choice"
                  onClick={() => selectReviewer(id, me)}
                >
                  Reviewer {id}
                  {hasClaims && (
                    <span className="reviewer-prompt-holder">{holder ? describeIdentity(holder) : 'Unclaimed'}</span>
                  )}
                </button>
              )
            })}
            <button
              type="button"
              className="reviewer-prompt-choice is-consolidation"
              onClick={() => selectReviewer('consolidation', me)}
              title={
                total > 0 && ready === total
                  ? 'Every paper has been annotated by all reviewers'
                  : 'Papers not yet annotated by every reviewer cannot be compared yet'
              }
            >
              Consolidation
              {/* Says how much there is to do rather than blocking the seat: a
                  consolidator may legitimately want to start on the papers that
                  are ready while the rest are still being reviewed. The ones
                  that are not ready say so in the list and keep their compare
                  popups shut. */}
              <span className="reviewer-prompt-ready">
                {total === 0
                  ? 'no papers yet'
                  : ready === 0
                    ? 'no papers ready yet'
                    : `${ready} of ${total} papers ready`}
              </span>
              {hasClaims && (
                <span className="reviewer-prompt-holder">
                  {project.reviewerIdentities.consolidation
                    ? describeIdentity(project.reviewerIdentities.consolidation)
                    : 'Unclaimed'}
                </span>
              )}
            </button>
          </div>
          <p className="reviewer-prompt-note">
            Remembered for this project — you can switch from the toolbar whenever you like.
          </p>
        </div>
      </div>
    </div>
  )
}
