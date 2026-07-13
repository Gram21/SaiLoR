import { useStore } from '../state/store'
import { hasAnnotations } from '../model/annotations'

/** Left pane: the collapsible list of papers to annotate. */
export function PaperList() {
  const project = useStore((s) => s.project)
  const currentPaperId = useStore((s) => s.currentPaperId)
  const selectPaper = useStore((s) => s.selectPaper)
  const schema = project?.schema ?? []

  if (!project) return null

  return (
    <div className="panel paper-list">
      <div className="paper-list-head">
        Papers <span className="count">({project.papers.length})</span>
      </div>
      <ul>
        {project.papers.map((p) => {
          const annotated = hasAnnotations(schema, p.annotations)
          return (
            <li
              key={p.id}
              className={p.id === currentPaperId ? 'paper active' : 'paper'}
              onClick={() => selectPaper(p.id)}
            >
              <span
                className={annotated ? 'status-dot done' : 'status-dot'}
                title={annotated ? 'Has annotations' : 'Not annotated yet'}
              />
              <span className="paper-info">
                <span className="paper-title">{p.title}</span>
                <span className="paper-authors">{p.authors.join(', ')}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
