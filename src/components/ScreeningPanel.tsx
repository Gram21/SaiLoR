// [impl->req~ui-80~1]
import { useStore, useAiMark, selectCurrentPaper, currentTree } from '../state/store'
import {
  SCREENING_DECISION,
  SCREENING_REASON,
  DECISION_INCLUDE,
  DECISION_EXCLUDE,
} from '../screening/schema'
import { screeningStatus } from '../screening/status'
import { screeningCounts, pendingUnanimous } from '../screening/counts'
import { ComboBox } from './ComboBox'
import { tp, useT } from '../i18n'

/**
 * Right-hand pane for a screening project — rendered by `App.tsx` instead of
 * `AnnotationPanel` whenever `project.screening` is set. Reuses the same
 * withheld-form / reviewer-badge / Consolidation-tools shapes `AnnotationPanel`
 * established, but the body is the two-button decision control screening
 * actually needs rather than a rendered schema tree — there is no schema to
 * render (see `src/screening/schema.ts`).
 */
export function ScreeningPanel() {
  const t = useT()
  const paper = useStore(selectCurrentPaper)
  const project = useStore((s) => s.project)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const readOnly = useStore((s) => s.readOnly)
  const setScreeningDecision = useStore((s) => s.setScreeningDecision)
  const setScreeningReason = useStore((s) => s.setScreeningReason)
  const setScreeningSummaryOpen = useStore((s) => s.setScreeningSummaryOpen)
  const setAgreementOpen = useStore((s) => s.setAgreementOpen)
  const setDisagreementsOpen = useStore((s) => s.setDisagreementsOpen)
  // [impl->req~scr-80~1]
  const adoptAllUnanimousScreening = useStore((s) => s.adoptAllUnanimousScreening)

  const [decisionMarked, confirmDecision] = useAiMark([], SCREENING_DECISION, 0)
  const [reasonMarked, confirmReason] = useAiMark([], SCREENING_REASON, 0)

  if (!paper) {
    return <div className="panel annotations empty">{t('screening.panel.selectPaper')}</div>
  }

  // Same withheld-form rule as AnnotationPanel: an edit made with nobody
  // picked would be unattributed.
  const noReviewerPicked = (project?.reviewers ?? 1) > 1 && currentReviewer === null
  if (noReviewerPicked || !project) {
    return (
      <div className="panel annotations empty">{t('screening.panel.pickReviewer')}</div>
    )
  }

  const isConsolidation = currentReviewer === 'consolidation'
  const tree = currentTree(project, currentReviewer, paper)
  const status = screeningStatus(tree)
  const reasons = project.screening?.reasons ?? []
  const counts = screeningCounts(project, currentReviewer)
  const pending = isConsolidation ? pendingUnanimous(project) : 0

  // [impl->req~scr-120~1]
  // [impl->req~scr-170~1]
  // [impl->req~scr-220~1]
  const decide = (decision: string) => {
    setScreeningDecision(status === (decision === DECISION_INCLUDE ? 'included' : 'excluded') ? null : decision)
  }

  return (
    <div className="panel annotations screening-panel">
      <fieldset className="read-only-fieldset" disabled={readOnly}>
      <div className="annotations-head">
        <div className="annotations-head-row">
          <h2>{t('screening.panel.title')}</h2>
        </div>
        <div className="annotations-paper-title">
          {paper.title}
          {(project.reviewers ?? 1) > 1 && (
            <span className="reviewer-badge">
              {isConsolidation ? t('consolidation.seatName') : t('consolidation.reviewerName', { id: currentReviewer ?? '' })}
            </span>
          )}
        </div>
        {/* Its own row, not squeezed next to the title: Consolidation adds two
            more buttons here than AnnotationPanel's equivalent ever has, and
            sharing `.annotations-head-row` with the title (as that panel does)
            has no room left for them at a normal panel width. */}
        <div className="consolidation-tools screening-tools-row">
          <button
            type="button"
            className="consolidation-tool-btn"
            title={t('screening.panel.summaryTitle')}
            onClick={() => setScreeningSummaryOpen(true)}
          >
            {t('screening.panel.summary')}
          </button>
          {isConsolidation && (
            <>
              <button
                type="button"
                className="consolidation-tool-btn"
                title={t('screening.panel.agreementTitle')}
                onClick={() => setAgreementOpen(true)}
              >
                {t('screening.panel.agreement')}
              </button>
              <button
                type="button"
                className="consolidation-tool-btn"
                title={t('screening.panel.disagreementsTitle')}
                onClick={() => setDisagreementsOpen(true)}
              >
                {t('screening.panel.disagreements')}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="annotations-body screening-body">
        {isConsolidation && pending > 0 && (
          <div className="screening-pending-notice">
            <span>{tp('screening.panel.pending', pending)}</span>
            <button
              type="button"
              onClick={() => adoptAllUnanimousScreening()}
              title={t('screening.panel.adoptAllTitle')}
            >
              {t('screening.panel.adoptAll')}
            </button>
          </div>
        )}

        <div className="screening-decision-row">
          <button
            type="button"
            className={`screening-decision-btn screening-include${status === 'included' ? ' active' : ''}${decisionMarked && status === 'included' ? ' ai-marked' : ''}`}
            title={t('screening.panel.includeTitle')}
            onClick={() => {
              confirmDecision()
              decide(DECISION_INCLUDE)
            }}
          >
            {t('screening.panel.include')}
          </button>
          <button
            type="button"
            className={`screening-decision-btn screening-exclude${status === 'excluded' ? ' active' : ''}${decisionMarked && status === 'excluded' ? ' ai-marked' : ''}`}
            title={t('screening.panel.excludeTitle')}
            onClick={() => {
              confirmDecision()
              decide(DECISION_EXCLUDE)
            }}
          >
            {t('screening.panel.exclude')}
          </button>
        </div>
        {status === 'undecided' && (
          <p className="screening-hint">{t('screening.panel.notYet')}</p>
        )}

        <label className="screening-reason-field">
          <span className="papers-label">
            {t('screening.panel.reasonLabel')}{' '}
            {status !== 'excluded' && <span className="papers-note">{t('screening.panel.reasonOnlyWhenExcluded')}</span>}
          </span>
          <ComboBox
            value={tree?.[SCREENING_REASON]?.[0]?.value === undefined ? null : (tree[SCREENING_REASON][0].value as string | null)}
            options={reasons}
            className={reasonMarked ? 'ai-marked' : ''}
            onInteract={confirmReason}
            onChange={(v) => setScreeningReason(v)}
            disabled={status !== 'excluded'}
          />
        </label>
        {status !== 'excluded' && (
          <p className="screening-hint">{t('screening.panel.reasonDisabled', { max: Math.min(9, reasons.length) })}</p>
        )}

        <p className="screening-progress">
          {t('screening.panel.progress', {
            screened: counts.included + counts.excluded,
            total: counts.total,
            included: counts.included,
            excluded: counts.excluded,
            left: counts.undecided,
          })}
        </p>
      </div>
      </fieldset>
    </div>
  )
}
