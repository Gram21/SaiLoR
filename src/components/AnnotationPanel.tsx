import { useStore, selectCurrentPaper, currentTree } from '../state/store'
import { useAiStore } from '../state/aiStore'
import { normalizeTree } from '../model/annotations'
import { AnnotationNode } from './AnnotationNode'

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

  // Consolidation is the pass where a human decides between what the reviewers
  // actually said. A model has no standing there: its answer would be a fresh
  // opinion invented after the fact, written straight into the tree that ships
  // and dressed as a reconciliation of the others. The button is not rendered at
  // all in this seat — not merely disabled or transparent, which is what the
  // locked state below does — and `applyAiSuggestions` refuses from here too, in
  // case the dialog was opened as a reviewer and the seat then switched.
  const isConsolidation = currentReviewer === 'consolidation'
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
      </div>
      <div className="annotations-body">
        {schema.map((def) => (
          <AnnotationNode key={def.id} def={def} path={[]} container={container} />
        ))}
      </div>
    </div>
  )
}
