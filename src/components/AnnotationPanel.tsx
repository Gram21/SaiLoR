import { useStore, selectCurrentPaper } from '../state/store'
import { useAiStore } from '../state/aiStore'
import { AnnotationNode } from './AnnotationNode'

/** Right-hand pane: renders the schema recursively for the current paper. */
export function AnnotationPanel() {
  const paper = useStore(selectCurrentPaper)
  const schema = useStore((s) => s.project?.schema ?? [])
  const busy = useStore((s) => s.busy)
  const aiEnabled = useStore((s) => s.project?.aiEnabled ?? true)
  const openAi = useAiStore((s) => s.openDialog)

  if (!paper) {
    return <div className="panel annotations empty">Select a paper to annotate.</div>
  }

  // The provider of the project file can turn AI off (config.ai: false). When they
  // have, say so on hover rather than leaving a silently dead button.
  const aiTitle = !aiEnabled
    ? 'AI annotation was turned off by the provider of this project file (config.ai: false).'
    : 'Ask an LLM to propose values for the fields that are still empty'

  return (
    <div className="panel annotations">
      <div className="annotations-head">
        <div className="annotations-head-row">
          <h2>Annotations</h2>
          <button
            type="button"
            className="ai-btn"
            title={aiTitle}
            disabled={busy || !paper.pdf || !aiEnabled}
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
