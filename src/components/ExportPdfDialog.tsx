import { useEffect, useRef, useState } from 'react'
import { useStore, selectCurrentPaper } from '../state/store'
import { getPlatform } from '../platform'
import { annotatedFileName } from '../model/pdfExport'
import { useT, tp } from '../i18n'
// For `.ai-error`, reused here for the same "inline error callout" look.
import '../styles/ai.css'
import { Modal } from './Modal'

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
  const t = useT()
  // [impl->req~pdf-160~1]
  const saveHandle = useStore((s) => s.saveHandle)

  const [absPath, setAbsPath] = useState<string | null>(null)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [target, setTarget] = useState<Target>('new')
  const [busy, setBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [successPath, setSuccessPath] = useState<string | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(closeTimer.current), [])

  useEffect(() => {
    if (!open || !paper) return
    setTarget('new')
    setExportError(null)
    setSuccessPath(null)
    setAbsPath(null)
    setResolveError(null)
    if (!saveHandle?.path) {
      setResolveError(t('exportPdf.notSaved'))
      return
    }
    setResolving(true)
    getPlatform()
      .absolutePdfPaths([paper.pdf], saveHandle)
      .then(([resolved]) => {
        if (!resolved) setResolveError(t('exportPdf.resolveError', { file: paper.pdf }))
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
          closeTimer.current = setTimeout(() => setOpen(false), 1500)
        }
      } else {
        const res = await platform.embedPdfAnnotations(absPath, marks, 'original')
        if (!res.ok) setExportError(res.error)
        else {
          setSuccessPath(res.path)
          closeTimer.current = setTimeout(() => setOpen(false), 1500)
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={close}>
      <div className="modal-head">
        <strong>{t('exportPdf.title')}</strong>
        <button type="button" className="icon-btn" title={t('common.close')} onClick={close} aria-label={t('common.close')}>
          ×
        </button>
      </div>
      <div className="modal-body">
        {successPath ? (
          <p>{t('exportPdf.exported', { path: successPath })}</p>
        ) : (
          <>
            <p>{tp('exportPdf.writes', marks.length)}</p>
            {resolving && <p>{t('exportPdf.locating')}</p>}
            {resolveError && <p className="ai-error">{resolveError}</p>}
            {!resolving && !resolveError && (
              <fieldset>
                <legend>{t('exportPdf.where')}</legend>
                <label>
                  <input
                    type="radio"
                    name="export-pdf-target"
                    checked={target === 'new'}
                    onChange={() => setTarget('new')}
                    disabled={busy}
                  />
                  <span>{t('exportPdf.targetNew')}</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="export-pdf-target"
                    checked={target === 'original'}
                    onChange={() => setTarget('original')}
                    disabled={busy}
                  />
                  <span>{t('exportPdf.targetOriginal')}</span>
                </label>
                {target === 'original' && (
                  <div className="consolidation-warning">
                    <p>{t('exportPdf.overwriteWarning')}</p>
                  </div>
                )}
              </fieldset>
            )}
            {exportError && <p className="ai-error">{exportError}</p>}
            <div className="screening-import-actions">
              <button type="button" title={t('exportPdf.cancelTitle')} disabled={busy} onClick={close}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary"
                title={t('exportPdf.exportTitle')}
                disabled={busy || resolving || !absPath}
                onClick={() => void runExport()}
              >
                {busy ? t('exportPdf.exporting') : t('exportPdf.export')}
              </button>
            </div>
          </>
        )}
      </div>
      
    </Modal>
  )
}
