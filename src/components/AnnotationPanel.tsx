// [impl->req~pdf-185~1]
// [impl->req~ui-80~1]
// [impl->req~con-500~1]
// [impl->req~llm-470~1]
// [impl->req~lst-80~1]
import { useEffect, useMemo } from 'react'
import { useStore, selectCurrentPaper, currentTree, currentFinished, consolidationGateMissing } from '../state/store'
import { normalizeTree, isFieldVisible } from '../model/annotations'
import { useT } from '../i18n'
import { aiSeatId, seatLabel } from '../model/project'
import { effectiveMetadata } from '../model/metadata'
import { paperCompleteness, paperAnnotationState } from './PaperList'
import { paperVerdicts } from '../consolidate/disagreements'
import { AnnotationNode } from './AnnotationNode'
import { SeatConflictNotice } from './SeatConflictNotice'
import { AiUsageDisclosure } from './AiUsageDisclosure'
import { StrictGate } from './StrictGate'
import {
  consolidationFieldStatus,
  ConsolidationVerdictsContext,
  type ConsolidationFieldStatus,
} from './ConsolidationVerdicts'

/** Right-hand pane: renders the schema recursively for the current paper. */
export function AnnotationPanel() {
  const t = useT()
  const paper = useStore(selectCurrentPaper)
  const screeningMarkCount = useStore((s) => (paper ? (s.screeningMarks?.[paper.id]?.length ?? 0) : 0))
  const showScreeningMarks = useStore((s) => s.showScreeningMarks)
  const setShowScreeningMarks = useStore((s) => s.setShowScreeningMarks)
  const project = useStore((s) => s.project)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const readOnly = useStore((s) => s.readOnly)
  const schema = project?.schema ?? []
  const setConsolidationOverviewOpen = useStore((s) => s.setConsolidationOverviewOpen)
  const setDisagreementsOpen = useStore((s) => s.setDisagreementsOpen)
  const setSchemaInfoOpen = useStore((s) => s.setSchemaInfoOpen)
  const setAnnotationFinished = useStore((s) => s.setAnnotationFinished)
  const pendingFieldJump = useStore((s) => s.pendingFieldJump)
  const setPendingFieldJump = useStore((s) => s.setPendingFieldJump)
  const flashFieldPath = useStore((s) => s.flashFieldPath)
  const setFlashFieldPath = useStore((s) => s.setFlashFieldPath)
  const gated = useStore((s) => consolidationGateMissing(s).length > 0)

  // Consolidation is the pass where a human decides between what the reviewers
  // actually said. A model has no standing there: its answer would be a fresh
  // opinion invented after the fact, written straight into the tree that ships
  // and dressed as a reconciliation of the others. The button is not rendered at
  // all in this seat — not merely disabled or transparent, which is what the
  // locked state below does — and `applyAiSuggestions` refuses from here too, in
  // case the dialog was opened as a reviewer and the seat then switched.
  const isConsolidation = currentReviewer === 'consolidation'

  // Hooks must run in the same order on every render, so this has to sit
  // above the early returns below (no paper selected, no reviewer picked) —
  // it used to sit after them, so picking a reviewer seat (or selecting a
  // paper) changed how many hooks this component called and crashed React
  // with "change in the order of Hooks". The memo itself stays a no-op
  // (empty map) until there's a paper and a reviewer to compute it for.
  //
  // One index for the whole panel, rather than asking every rendered Field to
  // re-walk all reviewer trees. Green needs all reviewer answers; a visible
  // disagreement is red as soon as two answers differ.
  const consolidationVerdicts = useMemo(() => {
    const verdicts = new Map<string, ConsolidationFieldStatus>()
    if (!isConsolidation || !project || !paper) return verdicts
    for (const verdict of paperVerdicts(project.schema, paper, project.reviewers)) {
      // [impl->req~ann-90~1]
      const status = consolidationFieldStatus(
        verdict.answeredBy.length,
        project.reviewers,
        verdict.agree,
        verdict.oneSided,
        verdict.participantCount,
      )
      if (status) verdicts.set(verdict.canonical, status)
    }
    return verdicts
  }, [isConsolidation, paper, project])

  // Which of the current paper's AI-usage records this seat should see:
  // Consolidation sees every run, a reviewer seat only the runs with no
  // `reviewer` attribution (predating that field, or genuinely seat-agnostic)
  // or attributed to itself — never another reviewer's own AI run.
  // [impl->req~llm-570~1]
  const relevantAiUsage = useMemo(() => {
    if (!paper) return []
    if (isConsolidation) return paper.aiUsage
    return paper.aiUsage.filter((r) => !r.reviewer || r.reviewer === currentReviewer)
  }, [paper, isConsolidation, currentReviewer])

  // A field jump requested from elsewhere (Validation's "jump to this
  // field", clicking an issue rather than only the paper it's on) — scroll
  // to it and start the flash, then clear the request. `selectPaper` (called
  // before this is set) already lands the right paper before this effect
  // runs, so every field is in the DOM by the time `querySelector` looks.
  useEffect(() => {
    if (!pendingFieldJump) return
    // [impl->req~ann-10~1]
    const el = document.querySelector(`[data-canonical="${CSS.escape(pendingFieldJump)}"]`)
    el?.scrollIntoView({ block: 'center' })
    setFlashFieldPath(pendingFieldJump)
    setPendingFieldJump(null)
  }, [pendingFieldJump, setPendingFieldJump, setFlashFieldPath])

  // The flash's own lifetime — split from the effect above so setting
  // `flashFieldPath` is always the one thing that starts (and restarts) it.
  useEffect(() => {
    if (!flashFieldPath) return
    const t = window.setTimeout(() => setFlashFieldPath(null), 4000)
    return () => window.clearTimeout(t)
  }, [flashFieldPath, setFlashFieldPath])

  if (!paper) {
    return <div className="panel annotations empty">{t('annotation.panel.selectPaper')}</div>
  }

  // Multi-reviewer, nobody has picked a seat yet: an edit made here would be
  // unattributed, so the form is withheld rather than guessing who it is for
  // (see `currentReviewer` in store.ts). The reviewer switch lives in the
  // toolbar above.
  // [impl->req~ann-80~1]
  const noReviewerPicked = (project?.reviewers ?? 1) > 1 && currentReviewer === null
  if (noReviewerPicked) {
    return (
      <div className="panel annotations empty">
        {t('annotation.panel.pickReviewer')}
      </div>
    )
  }
  if (gated) return <StrictGate />

  // Falls back to a schema-shaped empty tree for a reviewer who hasn't written
  // anything on this paper yet, without creating it just to render the form —
  // see `currentTree`'s `create` flag.
  const container = project
    ? (currentTree(project, currentReviewer, paper) ?? normalizeTree(schema, undefined))
    : paper.annotations

  // The "Annotation finished" checkbox — the reviewer's own sign-off, and the
  // only thing that turns this paper's dot green in the list (see
  // `annotationState`).
  //
  // Always present, never appearing and disappearing as the last field is
  // filled and cleared: a control that comes and goes is one a reviewer has
  // to hunt for, and its absence would read as "this paper cannot be
  // finished" rather than "not yet". The rule it enforces lives in the color
  // instead — ticked while the schema is unfulfilled is the `flagged` state,
  // red here and red in the list, rather than something the UI silently
  // prevents. That also makes "I am done with this one" sayable on a paper a
  // reviewer knows they cannot fill further, without the app pretending the
  // form is complete.
  //
  // Red is specifically "a field that had to be filled is empty", not "the
  // form is not full": see `annotationState`. A schema that marks nothing
  // required never turns red at all, and a Yes/No field left on "no" is an
  // answer rather than a hole, so neither can contradict the tick.
  //
  // The one place it is *not* shown is where `paperCompleteness` is null — a
  // screening project, which has its own tri-state marker and no notion of a
  // fulfilled schema at all. One rule (`completenessApplies`) governs the
  // checkbox, the dot color and the filter dropdown together.
  //
  // The Consolidation seat *does* get it: the consolidated tree is the record
  // that ships, so "I am done reconciling this paper" is the sign-off that most
  // needs saying, and the store has always routed that seat's tick to
  // `Paper.finished` — see `completenessApplies`. Only the wording changes
  // there, to name what is being signed off rather than to mean something
  // different by it.
  //
  // `config.finishCheckbox: false` removes the control entirely: with the
  // project deciding "done" from the data, a checkbox would either do nothing
  // or claim an authority it no longer has. See `Project.finishCheckbox`.
  const finishCheckboxEnabled = project?.finishCheckbox !== false
  const finishedCompleteness = project ? paperCompleteness(project, paper, currentReviewer) : null
  const isFinished = project ? currentFinished(project, currentReviewer, paper) === true : false
  const finishedState = project ? paperAnnotationState(project, paper, currentReviewer) : null
  // Red only once ticked: an unfilled paper nobody has claimed is finished is
  // simply unfinished, not wrong.
  const finishedMismatch = finishedState === 'flagged'
  const showFinished = finishCheckboxEnabled && finishedCompleteness !== null

  // Humans may still select the AI's seat to look at or correct its work — no
  // hard lock, just a heads-up about whose answers are sitting there.
  // [impl->req~ann-30~1]
  // [impl->req~ui-30~1]
  const isAiSeat = !!project && currentReviewer === aiSeatId(project)

  return (
    <div className="panel annotations">
      <SeatConflictNotice />
      {isAiSeat && (
        <p className="ai-seat-notice" role="status">
          {t('annotation.panel.aiSeat')}
        </p>
      )}
      <div className="annotations-head">
        <div className="annotations-head-row">
          <h2>{t('annotation.panel.title')}</h2>
          {!!project?.schemaInfo && (
            <button
              type="button"
              className="schema-info-btn"
              title={t('annotation.panel.schemaInfo')}
              aria-label={t('annotation.panel.schemaInfo')}
              onClick={() => setSchemaInfoOpen(true)}
            >
              ⓘ
            </button>
          )}
        </div>
        <div className="annotations-paper-title">
          {effectiveMetadata(paper, currentReviewer).title}
          {/* A second, redundant cue (besides the toolbar switch) right where the
              data is being edited — worth the repetition, since this is exactly
              what makes a multi-reviewer file trustworthy. */}
          {!noReviewerPicked && (project?.reviewers ?? 1) > 1 && (
            <span className="reviewer-badge">
              {project && currentReviewer
                ? seatLabel(project, currentReviewer)
                : t('annotation.panel.reviewerFallback', { id: String(currentReviewer) })}
            </span>
          )}
        </div>
        {project && <AiUsageDisclosure project={project} records={relevantAiUsage} />}
        {/* Only where the screening project this one came from marked this
            paper: an option with nothing behind it would only puzzle. */}
        {screeningMarkCount > 0 && (
          <label
            className="screening-marks-toggle"
            title={t('annotation.panel.screeningMarksTitle')}
          >
            <input
              type="checkbox"
              checked={showScreeningMarks}
              onChange={(e) => setShowScreeningMarks(e.target.checked)}
            />
            {t('annotation.panel.screeningMarks', { count: screeningMarkCount })}
          </label>
        )}
        {/* The project-wide actions live in the overview, while this row keeps
            navigation close to the paper being reconciled. */}
        {isConsolidation && (
          <div className="consolidation-tools annotations-tools-row">
            <button
              type="button"
              className="consolidation-tool-btn"
              title={t('annotation.panel.overviewTitle')}
              onClick={() => setConsolidationOverviewOpen(true)}
            >
              {t('annotation.panel.overview')}
            </button>
            <button
              type="button"
              className="consolidation-tool-btn"
              title={t('annotation.panel.disagreementsTitle')}
              onClick={() => setDisagreementsOpen(true)}
            >
              {t('annotation.panel.disagreements')}
            </button>
          </div>
        )}
        {showFinished && (
          <label
            className={`annotation-finished${finishedMismatch ? ' mismatch' : ''}${isFinished ? ' on' : ''}`}
            title={
              finishedMismatch
                ? t('annotation.finished.flaggedTitle')
                : isConsolidation
                  ? t('annotation.finished.consolidationTitle')
                  : t('annotation.finished.title')
            }
          >
            <input
              type="checkbox"
              checked={isFinished}
              disabled={readOnly}
              onChange={(e) => setAnnotationFinished(e.target.checked)}
            />
            <span>
              {/* Named for what it signs off, not for a different rule: the
                  consolidator's tick is stored, colored and counted exactly
                  like a reviewer's (see `completenessApplies`). The name lives
                  in the `annotation.finished.checkbox*` keys because the paper list's amber dot
                  points at this control by name. */}
              {isConsolidation ? t('annotation.finished.checkboxConsolidation') : t('annotation.finished.checkbox')}
              {finishedMismatch && t('annotation.finished.requiredEmpty')}
            </span>
          </label>
        )}
      </div>
      <div className="annotations-body">
        <fieldset className="read-only-fieldset" disabled={readOnly}>
        <ConsolidationVerdictsContext.Provider value={consolidationVerdicts}>
          {schema
            // `container` is both the top level and the root a cross-branch
            // `visibleIf` path resolves against — the same pair
            // `validatePaper`/`completeness` pass.
            .filter((def) => isFieldVisible(def, container, {}, container))
            .map((def) => (
              <AnnotationNode
                key={def.id}
                def={def}
                path={[]}
                container={container}
                root={container}
              />
            ))}
        </ConsolidationVerdictsContext.Provider>
        </fieldset>
      </div>
    </div>
  )
}
