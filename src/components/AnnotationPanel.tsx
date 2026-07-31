import { useEffect, useMemo } from 'react'
import { useStore, selectCurrentPaper, currentTree, currentFinished } from '../state/store'
import { useAiStore } from '../state/aiStore'
import { normalizeTree, isFieldVisible } from '../model/annotations'
import { paperCompleteness, paperAnnotationState } from './PaperList'
import { paperVerdicts } from '../consolidate/disagreements'
import { AnnotationNode } from './AnnotationNode'
import {
  consolidationFieldStatus,
  ConsolidationVerdictsContext,
  type ConsolidationFieldStatus,
} from './ConsolidationVerdicts'

/** Right-hand pane: renders the schema recursively for the current paper. */
export function AnnotationPanel() {
  const paper = useStore(selectCurrentPaper)
  const project = useStore((s) => s.project)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const schema = project?.schema ?? []
  const busy = useStore((s) => s.busy)
  // config.ai can still forbid AI use, but can no longer turn it on by itself —
  // it also needs the hidden per-session unlock. See `aiUnlocked` in store.ts.
  const aiEnabled = useStore((s) => s.project?.aiEnabled ?? true)
  const aiUnlocked = useStore((s) => s.aiUnlocked)
  const openAi = useAiStore((s) => s.openDialog)
  const setConsolidationOverviewOpen = useStore((s) => s.setConsolidationOverviewOpen)
  const setDisagreementsOpen = useStore((s) => s.setDisagreementsOpen)
  const setSchemaInfoOpen = useStore((s) => s.setSchemaInfoOpen)
  const setAnnotationFinished = useStore((s) => s.setAnnotationFinished)
  const pendingFieldJump = useStore((s) => s.pendingFieldJump)
  const setPendingFieldJump = useStore((s) => s.setPendingFieldJump)
  const flashFieldPath = useStore((s) => s.flashFieldPath)
  const setFlashFieldPath = useStore((s) => s.setFlashFieldPath)

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

  // A field jump requested from elsewhere (Validation's "jump to this
  // field", clicking an issue rather than only the paper it's on) — scroll
  // to it and start the flash, then clear the request. `selectPaper` (called
  // before this is set) already lands the right paper before this effect
  // runs, so every field is in the DOM by the time `querySelector` looks.
  useEffect(() => {
    if (!pendingFieldJump) return
    const el = document.querySelector(`[data-canonical="${CSS.escape(pendingFieldJump)}"]`)
    el?.scrollIntoView({ block: 'center' })
    setFlashFieldPath(pendingFieldJump)
    setPendingFieldJump(null)
  }, [pendingFieldJump, setPendingFieldJump, setFlashFieldPath])

  // The flash's own lifetime — split from the effect above so setting
  // `flashFieldPath` is always the one thing that starts (and restarts) it.
  useEffect(() => {
    if (!flashFieldPath) return
    const t = window.setTimeout(() => setFlashFieldPath(null), 1500)
    return () => window.clearTimeout(t)
  }, [flashFieldPath, setFlashFieldPath])

  if (!paper) {
    return <div className="panel annotations empty">Select a paper to annotate.</div>
  }

  // Multi-reviewer, nobody has picked a seat yet: an edit made here would be
  // unattributed, so the form is withheld rather than guessing who it is for
  // (see `currentReviewer` in store.ts). The reviewer switch lives in the
  // toolbar above.
  const noReviewerPicked = (project?.reviewers ?? 1) > 1 && currentReviewer === null
  if (noReviewerPicked) {
    return (
      <div className="panel annotations empty">
        Pick a reviewer above to start annotating — each reviewer's answers are
        recorded separately until Consolidation reconciles them into the final
        result.
      </div>
    )
  }

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
  // screening project or the Consolidation seat — since those seats have
  // their own dot meanings and no notion of a fulfilled schema at all. One
  // rule (`completenessApplies`) governs the checkbox, the dot color and the
  // filter dropdown together.
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

  const aiDisabled = busy || !paper.pdf || !aiEnabled || !aiUnlocked
  // Not unlocked this session at all (the hidden click gesture never
  // happened): the button doesn't just disable, it has no visible presence —
  // nothing should hint an AI feature exists to find. Once unlocked, a
  // project that explicitly turns AI off (config.ai: false) still shows the
  // button, visibly disabled — useful information once you already know the
  // feature is there, unlike the pre-unlock state.
  const aiHidden = !aiUnlocked
  // Deliberately uninformative: the button looks like any other disabled
  // control rather than one hinting that it can be unlocked.
  const aiTitle = aiDisabled ? 'Coming soon' : 'Ask an LLM to propose values for the fields that are still empty'

  return (
    <div className="panel annotations">
      <div className="annotations-head">
        <div className="annotations-head-row">
          <h2>Annotations</h2>
          {!!project?.schemaInfo && (
            <button
              type="button"
              className="schema-info-btn"
              title="About this schema"
              aria-label="About this schema"
              onClick={() => setSchemaInfoOpen(true)}
            >
              ⓘ
            </button>
          )}
          {!isConsolidation && (
            <button
              type="button"
              className={`ai-btn${aiHidden ? ' ai-btn-hidden' : ''}`}
              title={aiHidden ? undefined : aiTitle}
              disabled={aiDisabled}
              aria-hidden={aiHidden || undefined}
              onClick={() => void openAi()}
            >
              ✦ AI
            </button>
          )}
        </div>
        <div className="annotations-paper-title">
          {paper.title}
          {/* A second, redundant cue (besides the toolbar switch) right where the
              data is being edited — worth the repetition, since this is exactly
              what makes a multi-reviewer file trustworthy. */}
          {!noReviewerPicked && (project?.reviewers ?? 1) > 1 && (
            <span className="reviewer-badge">
              {currentReviewer === 'consolidation' ? 'Consolidation' : `Reviewer ${currentReviewer}`}
            </span>
          )}
        </div>
        {/* The project-wide actions live in the overview, while this row keeps
            navigation close to the paper being reconciled. */}
        {isConsolidation && (
          <div className="consolidation-tools annotations-tools-row">
            <button
              type="button"
              className="consolidation-tool-btn"
              title="Open the project-wide Consolidation overview"
              onClick={() => setConsolidationOverviewOpen(true)}
            >
              ☰ Overview
            </button>
            <button
              type="button"
              className="consolidation-tool-btn"
              title="List the annotation fields where reviewers disagree on this paper"
              onClick={() => setDisagreementsOpen(true)}
            >
              ⚠ Disagreements
            </button>
          </div>
        )}
        {showFinished && (
          <label
            className={`annotation-finished${finishedMismatch ? ' mismatch' : ''}${isFinished ? ' on' : ''}`}
            title={
              finishedMismatch
                ? 'This paper is marked finished while a required field is empty — its dot in the paper list is red until the field is filled in or the mark is removed'
                : 'Mark this paper as finished once you are done with it — only then does its dot in the paper list turn green'
            }
          >
            <input
              type="checkbox"
              checked={isFinished}
              onChange={(e) => setAnnotationFinished(e.target.checked)}
            />
            <span>
              Annotation finished
              {finishedMismatch && ' — required fields are empty'}
            </span>
          </label>
        )}
      </div>
      <div className="annotations-body">
        <ConsolidationVerdictsContext.Provider value={consolidationVerdicts}>
          {schema
            .filter((def) => isFieldVisible(def, container))
            .map((def) => (
              <AnnotationNode key={def.id} def={def} path={[]} container={container} />
            ))}
        </ConsolidationVerdictsContext.Provider>
      </div>
    </div>
  )
}
