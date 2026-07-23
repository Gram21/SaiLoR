import { useStore } from '../state/store'
import { readyCount } from '../consolidate/readiness'

/**
 * Shown when a multi-reviewer project is opened and nobody has picked a seat —
 * which, because the choice is persisted per project, means the first time this
 * file is opened on this machine.
 *
 * Until now that state was a single line where the annotation form should be.
 * It said what to do but not why any of it exists, and the whole point of a
 * multi-reviewer file — that reviewers work *independently*, that you will not
 * see anyone else's answers, that a separate pass reconciles them — is exactly
 * the thing a reviewer needs to know before they start rather than after.
 *
 * There is deliberately no way out but choosing: the choose screen withholds
 * the form without a seat anyway, so a dismiss button would only offer a state
 * in which nothing can be done. The choice is free, reversible from the
 * toolbar, and costs nothing to change later.
 */
export function ReviewerPrompt() {
  const project = useStore((s) => s.project)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const selectReviewer = useStore((s) => s.selectReviewer)
  const helpOpen = useStore((s) => s.helpOpen)

  if (!project || project.reviewers <= 1) return null
  // Yield to Help. Nothing else can be reached while this is up, so F1 is the
  // one way to go and read more before committing to a seat — and it would be
  // perverse for the prompt explaining multi-review to be what stops you.
  if (helpOpen) return null

  if (currentReviewer !== null) return null

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
            Pick the reviewer seat you are using for this session. Your selection is remembered only
            on this machine for this project and is never written to the project file.
          </p>
          <p>
            <strong>Consolidation</strong> is the pass that comes after. Whoever takes that seat sees
            everyone's answers side by side, settles the disagreements, and records the project's
            final result. It is not another opinion — it is the reconciliation of the others.
          </p>
          <p className="reviewer-prompt-ask">Which are you?</p>
          <div className="reviewer-prompt-choices">
            {reviewerIds.map((id) => {
              return (
                <button
                  key={id}
                  type="button"
                  className="reviewer-prompt-choice"
                  onClick={() => selectReviewer(id)}
                >
                  Reviewer {id}
                </button>
              )
            })}
            <button
              type="button"
              className="reviewer-prompt-choice is-consolidation"
              onClick={() => selectReviewer('consolidation')}
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
