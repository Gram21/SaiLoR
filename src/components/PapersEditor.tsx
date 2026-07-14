import { useState, type DragEvent } from 'react'
import { useEditorStore, type EditorPaper } from '../state/editorStore'
import { getPlatform } from '../platform'
import '../styles/papers-editor.css'

type DropPosition = 'before' | 'after'

interface DropTarget {
  uid: string
  position: DropPosition
}

/** Papers section of the project editor: the PDFs a project references. */
export function PapersEditor() {
  const papers = useEditorStore((s) => s.papers)
  const location = useEditorStore((s) => s.location)
  const busy = useEditorStore((s) => s.busy)
  const addPdfs = useEditorStore((s) => s.addPdfs)
  const removePaper = useEditorStore((s) => s.removePaper)
  const movePaper = useEditorStore((s) => s.movePaper)

  const [dragUid, setDragUid] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  // A row is only draggable while its handle is held: a permanently draggable
  // row swallows text selection inside its own inputs.
  const [armedUid, setArmedUid] = useState<string | null>(null)

  const isBrowser = getPlatform().kind !== 'electron'
  const jsonName = location?.name ?? 'the project JSON'

  const clearDrag = () => {
    setDragUid(null)
    setDropTarget(null)
    setArmedUid(null)
  }

  const onDragStart = (e: DragEvent<HTMLLIElement>, uid: string) => {
    e.dataTransfer.setData('text/plain', uid)
    e.dataTransfer.effectAllowed = 'move'
    setDragUid(uid)
  }

  const onDragOver = (e: DragEvent<HTMLLIElement>, uid: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const position: DropPosition =
      e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDropTarget((cur) =>
      cur && cur.uid === uid && cur.position === position ? cur : { uid, position },
    )
  }

  const onDrop = (e: DragEvent<HTMLLIElement>, uid: string) => {
    e.preventDefault()
    const source = e.dataTransfer.getData('text/plain') || dragUid
    const position = dropTarget?.uid === uid ? dropTarget.position : 'before'
    if (source && source !== uid) movePaper(source, uid, position)
    clearDrag()
  }

  const addButton = (
    <button type="button" className="primary" disabled={busy} onClick={() => void addPdfs()}>
      + Add PDFs…
    </button>
  )

  return (
    <section className="papers-editor">
      <header className="papers-head">
        <h3 className="papers-title">
          Papers <span className="papers-count">({papers.length})</span>
        </h3>
        {papers.length > 0 && addButton}
      </header>

      {isBrowser && (
        <p className="papers-hint">
          In the browser, added PDFs are stored by file name only — keep them next to {jsonName} or
          fix the relative path below.
        </p>
      )}

      {papers.length === 0 ? (
        <div className="papers-empty">
          <p>No PDFs yet.</p>
          <p className="papers-empty-note">
            PDFs are referenced by a path relative to {jsonName}, so the project stays portable as
            long as the PDFs travel with it.
          </p>
          {addButton}
        </div>
      ) : (
        <ul className="papers-list">
          {papers.map((paper, i) => (
            <li
              key={paper.uid}
              className={rowClass(paper.uid, dragUid, dropTarget)}
              draggable={armedUid === paper.uid}
              onDragStart={(e) => onDragStart(e, paper.uid)}
              onDragOver={(e) => onDragOver(e, paper.uid)}
              onDragLeave={() => setDropTarget((cur) => (cur?.uid === paper.uid ? null : cur))}
              onDrop={(e) => onDrop(e, paper.uid)}
              onDragEnd={clearDrag}
            >
              <span
                className="papers-handle"
                title="Drag to reorder"
                aria-hidden="true"
                onPointerDown={() => setArmedUid(paper.uid)}
                onPointerUp={() => setArmedUid(null)}
              >
                ⠿
              </span>
              <span className="papers-index">{i + 1}.</span>
              <PaperFields paper={paper} onRemove={() => removePaper(paper.uid)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function rowClass(uid: string, dragUid: string | null, dropTarget: DropTarget | null): string {
  const classes = ['papers-row']
  if (uid === dragUid) classes.push('dragging')
  if (dropTarget?.uid === uid && uid !== dragUid) {
    classes.push(dropTarget.position === 'before' ? 'drag-over-before' : 'drag-over-after')
  }
  return classes.join(' ')
}

interface PaperFieldsProps {
  paper: EditorPaper
  onRemove: () => void
}

/** The editable fields of one paper. */
function PaperFields({ paper, onRemove }: PaperFieldsProps) {
  const updatePaper = useEditorStore((s) => s.updatePaper)
  const patch = (p: Partial<EditorPaper>) => updatePaper(paper.uid, p)

  return (
    <div className="papers-fields">
      <div className="papers-field-row">
        <label className="papers-field grow">
          <span className="papers-label">Title</span>
          <input
            type="text"
            className="papers-input"
            value={paper.title}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </label>
        <button
          type="button"
          className="remove-btn papers-remove"
          title="Remove this paper"
          aria-label="Remove this paper"
          onClick={onRemove}
        >
          ×
        </button>
      </div>

      <div className="papers-field-row">
        <label className="papers-field">
          <span className="papers-label">
            id <span className="papers-note">unique</span>
          </span>
          <input
            type="text"
            className="papers-input mono small"
            value={paper.id}
            onChange={(e) => patch({ id: e.target.value })}
          />
        </label>
        <label className="papers-field grow">
          <span className="papers-label">Authors</span>
          <input
            type="text"
            className="papers-input"
            placeholder="Author One, Author Two"
            value={paper.authors}
            onChange={(e) => patch({ authors: e.target.value })}
          />
        </label>
        <label className="papers-field">
          <span className="papers-label">
            DOI <span className="papers-note">optional</span>
          </span>
          <input
            type="text"
            className="papers-input"
            value={paper.doi}
            onChange={(e) => patch({ doi: e.target.value })}
          />
        </label>
      </div>

      <label className="papers-field">
        <span className="papers-label">PDF (relative to the JSON)</span>
        <input
          type="text"
          className="papers-input mono"
          value={paper.pdf}
          onChange={(e) => patch({ pdf: e.target.value })}
        />
      </label>
    </div>
  )
}
