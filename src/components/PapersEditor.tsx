import { useMemo, useState, type DragEvent } from 'react'
import { useEditorStore, type EditorPaper } from '../state/editorStore'
import { getPlatform } from '../platform'
import '../styles/papers-editor.css'

/**
 * Ids sharing a trimmed value with another paper's — mirrors `validateDraft`'s
 * (`src/state/editorStore.ts`) own dedup exactly: same trim, same "empty
 * doesn't count" rule (an empty id already gets its own "missing id" error
 * there). A row flagged here is guaranteed to be one `validateDraft` would
 * also reject at save time — this only exists to surface it earlier, live,
 * as the reviewer types, rather than only after they click Save.
 */
export function duplicatePaperIds(papers: { id: string }[]): Set<string> {
  const trimmed = papers.map((p) => p.id.trim()).filter(Boolean)
  const counts = new Map<string, number>()
  for (const id of trimmed) counts.set(id, (counts.get(id) ?? 0) + 1)
  return new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id))
}

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
  const justAdded = useEditorStore((s) => s.justAdded)
  const screening = useEditorStore((s) => s.screening)
  const addPdfs = useEditorStore((s) => s.addPdfs)
  const addPdfFolder = useEditorStore((s) => s.addPdfFolder)
  const importReferences = useEditorStore((s) => s.importReferences)
  const importFromScreening = useEditorStore((s) => s.importFromScreening)
  const confirmAdded = useEditorStore((s) => s.confirmAdded)
  const removePaper = useEditorStore((s) => s.removePaper)
  const movePaper = useEditorStore((s) => s.movePaper)

  const [dragUid, setDragUid] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  // A row is only draggable while its handle is held: a permanently draggable
  // row swallows text selection inside its own inputs.
  const [armedUid, setArmedUid] = useState<string | null>(null)

  const isBrowser = getPlatform().kind !== 'electron'
  const jsonName = location?.name ?? 'the project JSON'

  // Live here so a reviewer sees an id collision the moment they cause it,
  // not only after clicking Save.
  const duplicateIds = useMemo(() => duplicatePaperIds(papers), [papers])

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

  // Removing a paper drops its `annotations` with it, and nothing migrates
  // them — the same hazard `SchemaTreeEditor`'s rename/remove guard exists
  // for, just triggered from the papers list instead of the schema tree.
  const confirmRemove = (paper: EditorPaper) => {
    const a = paper.annotations
    const hasAnswers = !!a && typeof a === 'object' && Object.keys(a).length > 0
    if (hasAnswers) {
      const name = paper.title || 'This paper'
      const ok = window.confirm(
        `"${name}" has recorded annotations. Removing it will discard them — including every ` +
          'reviewer\'s own — the next time the project is saved, and it cannot be undone afterwards.\n\nContinue?',
      )
      if (!ok) return
    }
    removePaper(paper.uid)
  }

  const actionButtons = (
    <div className="papers-actions">
      <button type="button" className="primary" disabled={busy} onClick={() => void addPdfs()}>
        + Add PDFs…
      </button>
      <button type="button" disabled={busy} onClick={() => void addPdfFolder()}>
        + Add folder…
      </button>
      <button type="button" disabled={busy} onClick={() => void importReferences()}>
        Import references…
      </button>
      {/* In-place import into an open screening project stays blocked — not
          because it is meaningless (a carried row is well-defined: undecided
          under this project's own reasons), but because the two-pass workflow
          this exists for is fully served by "New from screening…", which opens
          a *separate*, independently reasoned screening project instead — see
          `importFromScreening` in editorStore.ts. */}
      {!screening && (
        <button type="button" disabled={busy} onClick={() => void importFromScreening()}>
          Import from screening…
        </button>
      )}
    </div>
  )

  return (
    <section className="papers-editor">
      <header className="papers-head">
        <h3 className="papers-title">
          Papers <span className="papers-count">({papers.length})</span>
        </h3>
        {papers.length > 0 && actionButtons}
      </header>

      {isBrowser && (
        <p className="papers-hint">
          In the browser, added PDFs are stored by file name only — keep them next to {jsonName} or
          fix the relative path below.
        </p>
      )}

      {papers.length === 0 ? (
        <div className="papers-empty">
          <p>No papers yet.</p>
          <p className="papers-empty-note">
            {screening
              ? 'Screening is usually decided on title and abstract, so a PDF is optional here — a reference manager export brings in the metadata, and a PDF can be attached later for the papers that reach the next phase.'
              : `PDFs are referenced by a path relative to ${jsonName}, so the project stays portable as long as the PDFs travel with it. A reference manager export can fill in the details — attach matching PDFs afterward.`}
          </p>
          {actionButtons}
        </div>
      ) : (
        <ul className="papers-list">
          {papers.map((paper, i) => (
            <li
              key={paper.uid}
              // Addressed by 1-based index from the issue list above (`Paper
              // N: …`, `validateDraft` in editorStore.ts), so "Fix these
              // before saving" can jump here — see `jumpToPaper` in
              // ProjectEditor.tsx.
              id={`papers-row-${i}`}
              className={rowClass(paper.uid, dragUid, dropTarget, Boolean(justAdded[paper.uid]))}
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
              <PaperFields
                paper={paper}
                duplicateId={duplicateIds.has(paper.id.trim())}
                onRemove={() => confirmRemove(paper)}
                onInteract={() => confirmAdded(paper.uid)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function rowClass(
  uid: string,
  dragUid: string | null,
  dropTarget: DropTarget | null,
  justAdded: boolean,
): string {
  const classes = ['papers-row']
  if (justAdded) classes.push('just-added')
  if (uid === dragUid) classes.push('dragging')
  if (dropTarget?.uid === uid && uid !== dragUid) {
    classes.push(dropTarget.position === 'before' ? 'drag-over-before' : 'drag-over-after')
  }
  return classes.join(' ')
}

interface PaperFieldsProps {
  paper: EditorPaper
  /** This paper's id collides with another paper's — see `duplicateIds` in
   *  `PapersEditor`. */
  duplicateId: boolean
  onRemove: () => void
  /** The reviewer reached this row — drop its "just added" highlight. */
  onInteract: () => void
}

/** The editable fields of one paper. */
function PaperFields({ paper, duplicateId, onRemove, onInteract }: PaperFieldsProps) {
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
            onFocus={onInteract}
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
            {duplicateId && <span className="papers-field-warning"> — duplicate</span>}
          </span>
          <input
            type="text"
            className={`papers-input mono small${duplicateId ? ' papers-input-invalid' : ''}`}
            value={paper.id}
            aria-invalid={duplicateId}
            title={duplicateId ? 'Another paper already uses this id — ids must be unique.' : undefined}
            onFocus={onInteract}
            onChange={(e) => patch({ id: e.target.value })}
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
            onFocus={onInteract}
            onChange={(e) => patch({ doi: e.target.value })}
          />
        </label>
        <label className="papers-field grow">
          <span className="papers-label">Authors</span>
          <input
            type="text"
            className="papers-input"
            placeholder="Author One, Author Two"
            value={paper.authors}
            onFocus={onInteract}
            onChange={(e) => patch({ authors: e.target.value })}
          />
        </label>
      </div>

      <div className="papers-field-row">
        <label className="papers-field">
          <span className="papers-label">
            Year <span className="papers-note">optional</span>
          </span>
          <input
            type="text"
            inputMode="numeric"
            className="papers-input small"
            value={paper.year}
            onFocus={onInteract}
            onChange={(e) => patch({ year: e.target.value })}
          />
        </label>
        <label className="papers-field grow">
          <span className="papers-label">
            Venue <span className="papers-note">journal, conference, or publisher — optional</span>
          </span>
          <input
            type="text"
            className="papers-input"
            value={paper.venue}
            onFocus={onInteract}
            onChange={(e) => patch({ venue: e.target.value })}
          />
        </label>
      </div>

      <label className="papers-field">
        <span className="papers-label">
          Abstract <span className="papers-note">what screening reads when there is no PDF</span>
        </span>
        <textarea
          className="papers-input papers-abstract"
          rows={2}
          value={paper.abstract}
          onFocus={onInteract}
          onChange={(e) => patch({ abstract: e.target.value })}
        />
      </label>

      <label className="papers-field">
        <span className="papers-label">PDF (relative to the JSON)</span>
        <input
          type="text"
          className="papers-input mono"
          value={paper.pdf}
          onFocus={onInteract}
          onChange={(e) => patch({ pdf: e.target.value })}
        />
      </label>
    </div>
  )
}
