import { useStore, selectCurrentPaper } from '../state/store'
import { AnnotationNode } from './AnnotationNode'

/** Right-hand pane: renders the schema recursively for the current paper. */
export function AnnotationPanel() {
  const paper = useStore(selectCurrentPaper)
  const schema = useStore((s) => s.project?.schema ?? [])

  if (!paper) {
    return <div className="panel annotations empty">Select a paper to annotate.</div>
  }

  return (
    <div className="panel annotations">
      <div className="annotations-head">
        <h2>Annotations</h2>
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
