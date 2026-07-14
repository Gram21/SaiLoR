import { useStore, selectCurrentPaper } from '../state/store'
import { useAiStore } from '../state/aiStore'
import { AnnotationNode } from './AnnotationNode'

/** Right-hand pane: renders the schema recursively for the current paper. */
export function AnnotationPanel() {
  const paper = useStore(selectCurrentPaper)
  const schema = useStore((s) => s.project?.schema ?? [])
  const busy = useStore((s) => s.busy)
  const openAi = useAiStore((s) => s.openDialog)

  if (!paper) {
    return <div className="panel annotations empty">Select a paper to annotate.</div>
  }

  return (
    <div className="panel annotations">
      <div className="annotations-head">
        <div className="annotations-head-row">
          <h2>Annotations</h2>
          <button
            type="button"
            className="ai-btn"
            title="Ask an LLM to propose values for the fields that are still empty"
            disabled={busy || !paper.pdf}
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
