import { useEffect, useState } from 'react'
import { useStore, selectCurrentPaper } from '../state/store'
import { getPlatform } from '../platform'
import { annotatedFileName } from '../model/pdfExport'
// For `.ai-error`, reused here for the same "inline error callout" look.
import '../styles/ai.css'

type Target = 'new' | 'original'

/**
 * One-way export: burns the current reviewer's/consolidation's PDF marks
 * into real PDF annotation objects in an actual file. Deliberately separate
 * from the live in-app overlay — see `pdfMarks.ts`'s doc comment for why
 * that overlay never touches the PDF binary. Follows `ValidationDialog`'s
 * modal structure.
 */
export function ExportPdfDialog() {
  const open = useStore((s) => s.exportPdfOpen)
  const setOpen = useStore((s) => s.setExportPdfOpen)
  const paper = useStore(selectCurrentPaper)
  const marks = useStore((s) => s.currentPdfMarks())
  const saveHandle = useStore((s) => s.saveHandle)

  const [absPath, setAbsPath] = useState<string | null>(null)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [target, setTarget] = useState<Target>('new')
  const [busy, setBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [successPath, setSuccessPath] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !paper) return
    setTarget('new')
    setExportError(null)
    setSuccessPath(null)
    setAbsPath(null)
    setResolveError(null)
    if (!saveHandle?.path) {
      setResolveError('The project has not been saved yet, so there is no folder to resolve the PDF against.')
      return
    }
    setResolving(true)
    getPlatform()
      .absolutePdfPaths([paper.pdf], saveHandle)
      .then(([resolved]) => {
        if (!resolved) setResolveError(`Could not resolve "${paper.pdf}" to a file on disk.`)
        else setAbsPath(resolved)
      })
      .catch((err) => setResolveError(String(err)))
      .finally(() => setResolving(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paper?.id, saveHandle?.path])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open || !paper) return null

  const close = () => setOpen(false)

  const runExport = async () => {
    if (!absPath) return
    setExportError(null)
    setBusy(true)
    try {
      const platform = getPlatform()
      if (target === 'new') {
        const chosen = await platform.pickPdfExportPath(annotatedFileName(paper.pdf.split(/[\\/]/).pop() ?? paper.pdf))
        if (!chosen) {
          setBusy(false)
          return // cancelled — stay in the dialog
        }
        const res = await platform.embedPdfAnnotations(absPath, marks, { newPath: chosen })
        if (!res.ok) setExportError(res.error)
        else {
          setSuccessPath(res.path)
          setTimeout(() => setOpen(false), 1500)
        }
      } else {
        const res = await platform.embedPdfAnnotations(absPath, marks, 'original')
        if (!res.ok) setExportError(res.error)
        else {
          setSuccessPath(res.path)
          setTimeout(() => setOpen(false), 1500)
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <strong>Export PDF with annotations</strong>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {successPath ? (
            <p>Exported to {successPath}</p>
          ) : (
            <>
              <p>
                Writes {marks.length} highlight{marks.length === 1 ? '' : 's'}/note
                {marks.length === 1 ? '' : 's'} into a real PDF file, as standard annotation objects any
                PDF reader can show.
              </p>
              {resolving && <p>Locating the PDF file…</p>}
              {resolveError && <p className="ai-error">{resolveError}</p>}
              {!resolving && !resolveError && (
                <fieldset>
                  <legend>Where to save</legend>
                  <label>
                    <input
                      type="radio"
                      name="export-pdf-target"
                      checked={target === 'new'}
                      onChange={() => setTarget('new')}
                      disabled={busy}
                    />
                    <span>Save as a new PDF file</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="export-pdf-target"
                      checked={target === 'original'}
                      onChange={() => setTarget('original')}
                      disabled={busy}
                    />
                    <span>Save into the original PDF file</span>
                  </label>
                  {target === 'original' && (
                    <div className="consolidation-warning">
                      <p>
                        This overwrites the PDF file directly. Other reviewers share this same file — this
                        can affect what they see and is likely to cause a git merge conflict.
                      </p>
                    </div>
                  )}
                </fieldset>
              )}
              {exportError && <p className="ai-error">{exportError}</p>}
              <div className="screening-import-actions">
                <button type="button" disabled={busy} onClick={close}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || resolving || !absPath}
                  onClick={() => void runExport()}
                >
                  {busy ? 'Exporting…' : 'Export'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
