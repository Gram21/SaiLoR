import { useMemo, useRef, useState, type DragEvent } from 'react'
import { useEditorStore, type EditorPaper } from '../state/editorStore'
import { getPlatform } from '../platform'
import { paperIdProblem, paperIdKey, type PaperIdIssue } from '../model/paperId'
import { t, useT } from '../i18n'
import '../styles/papers-editor.css'

/** A short label for `idProblem.reason`, for the same spot the duplicate flag
 *  uses — `idProblem.detail` (the full explanation) goes in the `title` instead. */
function idProblemLabel(reason: PaperIdIssue['reason']): string {
  switch (reason) {
    case 'illegal-char':
    case 'control-char':
      return t('editor.papers.problem.invalidChar')
    case 'reserved-name':
      return t('editor.papers.problem.reservedName')
    case 'trailing-dot-or-space':
      return t('editor.papers.problem.trailingDotOrSpace')
    case 'dot':
    case 'empty':
      return t('editor.papers.problem.invalidId')
  }
}

// [impl->req~edt-20~1]
/**
 * Ids that are unsafe as a directory name — mirrors `validateDraft`'s
 * (`src/state/editorStore.ts`) own check exactly, via the same
 * `paperIdProblem` (`src/model/paperId.ts`). A row flagged here is guaranteed
 * to be one `validateDraft` would also reject at save time — this only
 * exists to surface it earlier, live, as the reviewer types.
 */
export function unsafePaperIds(papers: { id: string }[]): Map<string, PaperIdIssue> {
  const problems = new Map<string, PaperIdIssue>()
  for (const p of papers) {
    const id = p.id.trim()
    // Empty ids already get their own "missing id" error; not this one.
    if (!id) continue
    // [impl->req~edt-90~1]
    const problem = paperIdProblem(id)
    if (problem) problems.set(id, problem)
  }
  return problems
}

/**
 * Ids that would share a folder with another paper's — the same comparison
 * `validateDraft` (`src/state/editorStore.ts`) makes at save time, via the one
 * shared `paperIdKey`: same trim, same "empty doesn't count" rule (an empty id
 * already gets its own "missing id" error there), and the same case- and
 * normalisation-insensitivity, so `P1` next to `p1` is flagged while it is
 * typed rather than only once Save refuses it. Returns the trimmed ids as
 * written, which is what each row looks itself up by.
 */
export function duplicatePaperIds(papers: { id: string }[]): Set<string> {
  const trimmed = papers.map((p) => p.id.trim()).filter(Boolean)
  const counts = new Map<string, number>()
  for (const id of trimmed) counts.set(paperIdKey(id), (counts.get(paperIdKey(id)) ?? 0) + 1)
  return new Set(trimmed.filter((id) => (counts.get(paperIdKey(id)) ?? 0) > 1))
}

type DropPosition = 'before' | 'after'

interface DropTarget {
  uid: string
  position: DropPosition
}

/** Papers section of the project editor: the PDFs a project references. */
export function PapersEditor() {
  const t = useT()
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

  const isBrowser = getPlatform().kind === 'browser'
  // [impl->req~edt-50~1]
  const jsonName = location?.name ?? t('editor.papers.jsonFallback')

  // Live here so a reviewer sees an id collision the moment they cause it,
  // not only after clicking Save.
  const duplicateIds = useMemo(() => duplicatePaperIds(papers), [papers])
  const idProblems = useMemo(() => unsafePaperIds(papers), [papers])

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
      const name = paper.title || t('editor.papers.thisPaper')
      const ok = window.confirm(t('editor.papers.removeConfirm', { name }))
      if (!ok) return
    }
    removePaper(paper.uid)
  }

  // A paper's annotation files live in `annotations/<id>/`, so the id is the
  // only thing tying them to the paper. Renaming it carries this checkout's
  // own answers along (the editor holds them and writes them under the new
  // id), but it cannot carry what is not here yet: a reviewer whose work has
  // not been pulled is still recording under the old id, and after the rename
  // lands nothing points at it. The old folder is also left on disk.
  // [impl->req~edt-45~1]
  const confirmIdChange = (paper: EditorPaper, from: string): boolean => {
    const a = paper.annotations
    const hasAnswers = !!a && typeof a === 'object' && Object.keys(a).length > 0
    if (!hasAnswers) return true
    return window.confirm(t('editor.papers.idChangeConfirm', { from }))
  }

  const actionButtons = (
    <div className="papers-actions">
      <button
        type="button"
        className="primary"
        title={t('editor.papers.addPdfsTitle')}
        disabled={busy}
        onClick={() => void addPdfs()}
      >
        {t('editor.papers.addPdfs')}
      </button>
      <button
        type="button"
        title={t('editor.papers.addFolderTitle')}
        disabled={busy}
        onClick={() => void addPdfFolder()}
      >
        {t('editor.papers.addFolder')}
      </button>
      <button
        type="button"
        title={t('editor.papers.importReferencesTitle')}
        disabled={busy}
        onClick={() => void importReferences()}
      >
        {t('editor.papers.importReferences')}
      </button>
      {/* In-place import into an open screening project stays blocked — not
          because it is meaningless (a carried row is well-defined: undecided
          under this project's own reasons), but because the two-pass workflow
          this exists for is fully served by "New from screening…", which opens
          a *separate*, independently reasoned screening project instead — see
          `importFromScreening` in editorStore.ts. */}
      {!screening && (
        <button
          type="button"
          title={t('editor.papers.importFromScreeningTitle')}
          disabled={busy}
          onClick={() => void importFromScreening()}
        >
          {t('editor.papers.importFromScreening')}
        </button>
      )}
    </div>
  )

  return (
    <section className="papers-editor">
      <header className="papers-head">
        <h3 className="papers-title">
          {t('editor.papers.title')} <span className="papers-count">({papers.length})</span>
        </h3>
        {papers.length > 0 && actionButtons}
      </header>

      {isBrowser && (
        <p className="papers-hint">
          {t('editor.papers.browserHint', { jsonName })}
        </p>
      )}

      {papers.length === 0 ? (
        <div className="papers-empty">
          <p>{t('editor.papers.empty')}</p>
          <p className="papers-empty-note">
            {screening ? t('editor.papers.emptyNoteScreening') : t('editor.papers.emptyNote', { jsonName })}
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
                title={t('editor.papers.dragTitle')}
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
                idProblem={idProblems.get(paper.id.trim())}
                onRemove={() => confirmRemove(paper)}
                onInteract={() => confirmAdded(paper.uid)}
                onIdChange={(from) => confirmIdChange(paper, from)}
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
  /** This paper's id is unsafe as a directory name — see `idProblems` in
   *  `PapersEditor`. Checked separately from `duplicateId`: an id can be
   *  unique and still unsafe (e.g. it contains a `?`). */
  idProblem: PaperIdIssue | undefined
  onRemove: () => void
  /** Asks whether an id may change from `from`; false puts the old one back. */
  onIdChange: (from: string) => boolean
  /** The reviewer reached this row — drop its "just added" highlight. */
  onInteract: () => void
}

/** The editable fields of one paper. */
function PaperFields({ paper, duplicateId, idProblem, onRemove, onInteract, onIdChange }: PaperFieldsProps) {
  const t = useT()
  // Confirmed on blur, not per keystroke — the same "ask once the new name is
  // settled" shape `SchemaTreeEditor`'s rename guard uses.
  const idOnFocus = useRef<string | null>(null)
  const updatePaper = useEditorStore((s) => s.updatePaper)
  const patch = (p: Partial<EditorPaper>) => updatePaper(paper.uid, p)

  return (
    <div className="papers-fields">
      <div className="papers-field-row">
        <label className="papers-field grow">
          <span className="papers-label">{t('editor.papers.titleLabel')}</span>
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
          title={t('editor.papers.removeTitle')}
          aria-label={t('editor.papers.removeTitle')}
          onClick={onRemove}
        >
          ×
        </button>
      </div>

      <div className="papers-field-row">
        <label className="papers-field">
          <span className="papers-label">
            {t('editor.papers.id')} <span className="papers-note">{t('editor.papers.unique')}</span>
            {duplicateId && <span className="papers-field-warning">{t('editor.papers.duplicateSuffix')}</span>}
            {!duplicateId && idProblem && (
              <span className="papers-field-warning">
                {t('editor.papers.idProblemSuffix', { label: idProblemLabel(idProblem.reason) })}
              </span>
            )}
          </span>
          <input
            type="text"
            className={`papers-input mono small${duplicateId || idProblem ? ' papers-input-invalid' : ''}`}
            value={paper.id}
            aria-invalid={duplicateId || Boolean(idProblem)}
            title={
              duplicateId
                ? t('editor.papers.duplicateIdTitle')
                : idProblem
                  ? t('editor.papers.idProblemTitle', { detail: idProblem.detail })
                  : undefined
            }
            onFocus={() => {
              idOnFocus.current = paper.id
              onInteract()
            }}
            onBlur={() => {
              const from = idOnFocus.current
              idOnFocus.current = null
              if (from === null || from.trim() === paper.id.trim()) return
              if (!onIdChange(from)) {
                patch({ id: from })
                return
              }
              // Normalise on commit, not per keystroke: a manually typed accented
              // id otherwise keeps whatever Unicode normalisation the OS handed
              // back (macOS's filesystem hands back NFD, everywhere else NFC),
              // so the same characters would name two different directories
              // depending which platform the id was typed on.
              // [impl->req~edt-21~1]
              const normalized = paper.id.normalize('NFC')
              if (normalized !== paper.id) patch({ id: normalized })
            }}
            onChange={(e) => patch({ id: e.target.value })}
          />
        </label>
        <label className="papers-field">
          <span className="papers-label">
            {t('editor.papers.doi')} <span className="papers-note">{t('editor.project.optional')}</span>
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
          <span className="papers-label">{t('editor.papers.authors')}</span>
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
            {t('editor.papers.year')} <span className="papers-note">{t('editor.project.optional')}</span>
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
            {t('editor.papers.venue')} <span className="papers-note">{t('editor.papers.venueNote')}</span>
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
          {t('editor.papers.abstract')} <span className="papers-note">{t('editor.papers.abstractNote')}</span>
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
        <span className="papers-label">{t('editor.papers.pdf')}</span>
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
