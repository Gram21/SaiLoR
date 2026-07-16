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

/**
 * Right-hand pane for a screening project — rendered by `App.tsx` instead of
 * `AnnotationPanel` whenever `project.screening` is set. Reuses the same
 * withheld-form / reviewer-badge / Consolidation-tools shapes `AnnotationPanel`
 * established, but the body is the two-button decision control screening
 * actually needs rather than a rendered schema tree — there is no schema to
 * render (see `src/screening/schema.ts`).
 */
export function ScreeningPanel() {
  const paper = useStore(selectCurrentPaper)
  const project = useStore((s) => s.project)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const setScreeningDecision = useStore((s) => s.setScreeningDecision)
  const setScreeningReason = useStore((s) => s.setScreeningReason)
  const setScreeningSummaryOpen = useStore((s) => s.setScreeningSummaryOpen)
  const setAgreementOpen = useStore((s) => s.setAgreementOpen)
  const setDisagreementsOpen = useStore((s) => s.setDisagreementsOpen)
  const adoptAllUnanimousScreening = useStore((s) => s.adoptAllUnanimousScreening)

  const [decisionMarked, confirmDecision] = useAiMark([], SCREENING_DECISION, 0)
  const [reasonMarked, confirmReason] = useAiMark([], SCREENING_REASON, 0)

  if (!paper) {
    return <div className="panel annotations empty">Select a paper to screen.</div>
  }

  // Same withheld-form rule as AnnotationPanel: an edit made with nobody
  // picked would be unattributed.
  const noReviewerPicked = (project?.reviewers ?? 1) > 1 && currentReviewer === null
  if (noReviewerPicked || !project) {
    return (
      <div className="panel annotations empty">
        Pick a reviewer above to start screening — each reviewer's decisions are
        recorded separately until Consolidation reconciles them into the final result.
      </div>
    )
  }

  const isConsolidation = currentReviewer === 'consolidation'
  const tree = currentTree(project, currentReviewer, paper)
  const status = screeningStatus(tree)
  const reasons = project.screening?.reasons ?? []
  const counts = screeningCounts(project, currentReviewer)
  const pending = isConsolidation ? pendingUnanimous(project) : 0

  const decide = (decision: string) => {
    setScreeningDecision(status === (decision === DECISION_INCLUDE ? 'included' : 'excluded') ? null : decision)
  }

  return (
    <div className="panel annotations screening-panel">
      <div className="annotations-head">
        <div className="annotations-head-row">
          <h2>Screening</h2>
          <div className="consolidation-tools">
            <button
              type="button"
              className="consolidation-tool-btn"
              title="Progress and PRISMA-style include/exclude/reason counts"
              onClick={() => setScreeningSummaryOpen(true)}
            >
              ◧ Summary
            </button>
            {isConsolidation && (
              <>
                <button
                  type="button"
                  className="consolidation-tool-btn"
                  title="Compute inter-rater agreement on the include/exclude decision"
                  onClick={() => setAgreementOpen(true)}
                >
                  ⚖ Agreement
                </button>
                <button
                  type="button"
                  className="consolidation-tool-btn"
                  title="List every paper where reviewers disagree"
                  onClick={() => setDisagreementsOpen(true)}
                >
                  ⚠ Disagreements
                </button>
              </>
            )}
          </div>
        </div>
        <div className="annotations-paper-title">
          {paper.title}
          {(project.reviewers ?? 1) > 1 && (
            <span className="reviewer-badge">
              {isConsolidation ? 'Consolidation' : `Reviewer ${currentReviewer}`}
            </span>
          )}
        </div>
      </div>

      <div className="annotations-body screening-body">
        {isConsolidation && pending > 0 && (
          <div className="screening-pending-notice">
            <span>
              {pending} paper{pending === 1 ? '' : 's'} every reviewer decided the same way{' '}
              {pending === 1 ? 'has' : 'have'} not been consolidated yet.
            </span>
            <button type="button" onClick={() => adoptAllUnanimousScreening()}>
              Adopt all
            </button>
          </div>
        )}

        <div className="screening-decision-row">
          <button
            type="button"
            className={`screening-decision-btn screening-include${status === 'included' ? ' active' : ''}${decisionMarked && status === 'included' ? ' ai-marked' : ''}`}
            title="Include this paper (shortcut: I)"
            onClick={() => {
              confirmDecision()
              decide(DECISION_INCLUDE)
            }}
          >
            ✓ Include
          </button>
          <button
            type="button"
            className={`screening-decision-btn screening-exclude${status === 'excluded' ? ' active' : ''}${decisionMarked && status === 'excluded' ? ' ai-marked' : ''}`}
            title="Exclude this paper (shortcut: E)"
            onClick={() => {
              confirmDecision()
              decide(DECISION_EXCLUDE)
            }}
          >
            ✕ Exclude
          </button>
        </div>
        {status === 'undecided' && (
          <p className="screening-hint">Not screened yet. Press I to include, E to exclude.</p>
        )}

        <label className="screening-reason-field">
          <span className="papers-label">
            Reason {status !== 'excluded' && <span className="papers-note">only applies when excluded</span>}
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
          <p className="screening-hint">
            The exclusion reason is disabled — a reason only makes sense once this paper is excluded.
            Shortcuts 1-{Math.min(9, reasons.length)} exclude with that reason in one press.
          </p>
        )}

        <p className="screening-progress">
          {counts.included + counts.excluded} of {counts.total} screened
          {' — '}
          {counts.included} included, {counts.excluded} excluded, {counts.undecided} left
        </p>
      </div>
    </div>
  )
}
