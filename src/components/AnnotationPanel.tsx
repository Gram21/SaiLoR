import { useStore, selectCurrentPaper } from '../state/store'
import { useAiStore } from '../state/aiStore'
import { AnnotationNode } from './AnnotationNode'

/** Right-hand pane: renders the schema recursively for the current paper. */
export function AnnotationPanel() {
  const paper = useStore(selectCurrentPaper)
  const schema = useStore((s) => s.project?.schema ?? [])
  const busy = useStore((s) => s.busy)
  // config.ai can still forbid AI use, but can no longer turn it on by itself —
  // it also needs the hidden per-session unlock. See `aiUnlocked` in store.ts.
  const aiEnabled = useStore((s) => s.project?.aiEnabled ?? true)
  const aiUnlocked = useStore((s) => s.aiUnlocked)
  const openAi = useAiStore((s) => s.openDialog)

  if (!paper) {
    return <div className="panel annotations empty">Select a paper to annotate.</div>
  }

  const aiDisabled = busy || !paper.pdf || !aiEnabled || !aiUnlocked
  // Deliberately uninformative: the button looks like any other disabled
  // control rather than one hinting that it can be unlocked.
  const aiTitle = aiDisabled ? 'Coming soon' : 'Ask an LLM to propose values for the fields that are still empty'

  return (
    <div className="panel annotations">
      <div className="annotations-head">
        <div className="annotations-head-row">
          <h2>Annotations</h2>
          <button
            type="button"
            className="ai-btn"
            title={aiTitle}
            disabled={aiDisabled}
            onClick={() => void openAi()}
          >
            ✦ AI
          </button>
        </div>
        <div className="annotations-paper-title">{paper.title}</div>
      </div>
      <div className="annotations-body">
        {schema.map((def) => (
          <AnnotationNode key={def.id} def={def} path={[]} container={paper.annotations} />
        ))}
      </div>
    </div>
  )
}
