// [impl->req~scr-320~1]
import { useEditorStore } from '../state/editorStore'
import { rich, tp, useT } from '../i18n'
import { Modal } from './Modal'

/**
 * Pre-commit summary shown after picking a screening project via
 * "New from screening…" or "Import from screening…", before anything is
 * written. Follows the `ValidationDialog` modal pattern.
 *
 * Undecided papers are carried by default (dropping them would silently
 * remove papers from a systematic review) — this dialog is what makes that
 * explicit rather than silent, and gives the reviewer the "leave them out"
 * escape hatch.
 */
export function ScreeningImportDialog() {
  const t = useT()
  const draft = useEditorStore((s) => s.screeningImport)
  const resolveScreeningImport = useEditorStore((s) => s.resolveScreeningImport)
  const setScreeningImportKind = useEditorStore((s) => s.setScreeningImportKind)
  const busy = useEditorStore((s) => s.busy)

  if (!draft) return null

  const reasonRows = Object.entries(draft.excludedByReason).sort(([, a], [, b]) => b - a)
  const totalScreened = draft.included.length + draft.excludedCount + draft.undecided.length

  return (
    <Modal onClose={() => resolveScreeningImport('cancel')} className="screening-import-dialog">
      <div className="modal-head">
        <strong>{t('screening.import.title', { source: draft.sourceName })}</strong>
        <button
          type="button"
          className="icon-btn"
          title={t('screening.import.cancelTitle')}
          onClick={() => resolveScreeningImport('cancel')}
          aria-label={t('common.close')}
        >
          ×
        </button>
      </div>
      <div className="modal-body">
        <p>{t('screening.import.total', { count: totalScreened })}</p>
        <ul className="screening-import-counts">
          <li>
            <strong>{draft.included.length}</strong> {t('screening.import.includedNote')}
          </li>
          <li>
            <strong>{draft.excludedCount}</strong> {t('screening.import.excludedNote')}
            {reasonRows.length > 0 && (
              <ul className="screening-import-reasons">
                {reasonRows.map(([reason, n]) => (
                  <li key={reason}>
                    {reason}: {n}
                  </li>
                ))}
              </ul>
            )}
          </li>
          <li>
            <strong>{draft.undecided.length}</strong> {t('screening.import.undecidedNote')}
          </li>
        </ul>
        {draft.reviewers > 1 && draft.pendingUnanimousCount > 0 && (
          <p className="screening-import-notice">
            {rich('screening.import.pendingNotice', { count: draft.pendingUnanimousCount })}
          </p>
        )}
        {draft.target === 'start' && (
          <fieldset className="screening-import-kind">
            <legend>{t('screening.import.createAs')}</legend>
            <label>
              <input
                type="radio"
                name="screening-import-kind"
                checked={draft.startKind === 'annotation'}
                onChange={() => setScreeningImportKind('annotation')}
                disabled={busy}
              />
              <span>{t('screening.import.kindAnnotation')}</span>
            </label>
            <label>
              <input
                type="radio"
                name="screening-import-kind"
                checked={draft.startKind === 'screening'}
                onChange={() => setScreeningImportKind('screening')}
                disabled={busy}
              />
              <span>{t('screening.import.kindScreening')}</span>
            </label>
            {draft.startKind === 'screening' && (
              <p className="screening-import-kind-hint">
                {t('screening.import.kindHint', { source: draft.sourceName })}
              </p>
            )}
          </fieldset>
        )}
        <div className="screening-import-actions">
          <button
            type="button"
            title={t('screening.import.cancelTitle')}
            disabled={busy}
            onClick={() => resolveScreeningImport('cancel')}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            title={t('screening.import.skipTitle')}
            disabled={busy}
            onClick={() => void resolveScreeningImport('skip-undecided')}
          >
            {tp('screening.import.skip', draft.undecided.length)}
          </button>
          <button
            type="button"
            className="primary"
            title={t('screening.import.importTitle')}
            disabled={busy}
            onClick={() => void resolveScreeningImport('include-undecided')}
          >
            {tp('screening.import.import', draft.included.length + draft.undecided.length)}
          </button>
        </div>
      </div>
      
    </Modal>
  )
}
