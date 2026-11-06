// [impl->req~con-20~1]
import { STRICT_MANAGER, useStore } from '../state/store'
import { strictActive } from '../model/strict'
import { readyCount } from '../consolidate/readiness'
import { CONSOLIDATION_SEAT } from '../git/seatOwner'
import { rich, useT } from '../i18n'
import { Modal } from './Modal'

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
 *
 * Deliberately says nothing about who "owns" a seat. A seat is not a person:
 * a large review divides its papers among many more people than it has seats,
 * so seat 1 is legitimately held by a different reviewer on every paper. The
 * collision that matters — somebody has already read *this* paper in *this*
 * seat — is caught where the paper is, not here (see `SeatConflictNotice`).
 */
export function ReviewerPrompt() {
  const project = useStore((s) => s.project)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const selectReviewer = useStore((s) => s.selectReviewer)
  const helpOpen = useStore((s) => s.helpOpen)
  const strictPerson = useStore((s) => s.strictPerson)
  const t = useT()
  if (!project || project.reviewers <= 1) return null
  if (strictActive(project) && strictPerson !== STRICT_MANAGER) return null
  // Yield to Help. Nothing else can be reached while this is up, so F1 is the
  // one way to go and read more before committing to a seat — and it would be
  // perverse for the prompt explaining multi-review to be what stops you.
  if (helpOpen) return null

  if (currentReviewer !== null) return null

  const reviewerIds = Array.from({ length: project.reviewers }, (_, i) => String(i + 1))
  const ready = readyCount(project.schema, project.papers, project.reviewers)
  // [impl->req~con-10~1]
  // [impl->req~con-70~1]
  const total = project.papers.length

  return (
    // Opt-out marker excludes this overlay from useKeybindings.ts's F1 guard,
    // so F1 still opens Help while this prompt is up (see that file's F1
    // branch for why the exclusion lives there and not in a keydown handler
    // here).
    <Modal yieldsToHelp className="reviewer-prompt">
      <div className="modal-head">
        <strong>{t('prompt.reviewer.title', { count: project.reviewers })}</strong>
      </div>
      <div className="modal-body">
        <p>{rich('prompt.reviewer.intro', { count: project.reviewers })}</p>
        <p>{t('prompt.reviewer.pick')}</p>
        <p>{rich('prompt.reviewer.consolidation')}</p>
        <p className="reviewer-prompt-ask">{t('prompt.reviewer.ask')}</p>
        <div className="reviewer-prompt-choices">
          {reviewerIds.map((id) => {
            return (
              <button
                key={id}
                type="button"
                className="reviewer-prompt-choice"
                onClick={() => selectReviewer(id)}
                title={t('prompt.reviewer.choiceTitle', { id })}
              >
                {t('toolbar.reviewer.name', { n: id })}
              </button>
            )
          })}
          <button
            type="button"
            className="reviewer-prompt-choice is-consolidation"
            onClick={() => selectReviewer(CONSOLIDATION_SEAT)}
            title={
              total > 0 && ready === total
                ? t('prompt.reviewer.readyTitle')
                : t('prompt.reviewer.notReadyTitle')
            }
          >
            {t('toolbar.reviewer.consolidation')}
            {/* Says how much there is to do rather than blocking the seat: a
                consolidator may legitimately want to start on the papers that
                are ready while the rest are still being reviewed. The ones
                that are not ready say so in the list and keep their compare
                popups shut. */}
            <span className="reviewer-prompt-ready">
              {total === 0
                ? t('prompt.reviewer.noPapers')
                : ready === 0
                  ? t('prompt.reviewer.noneReady')
                  : t('prompt.reviewer.progress', { ready, total })}
            </span>
          </button>
        </div>
        <p className="reviewer-prompt-note">{t('prompt.reviewer.note')}</p>
      </div>
      
    </Modal>
  )
}
