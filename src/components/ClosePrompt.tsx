import { useEffect } from 'react'
import { useStore } from '../state/store'
import { useT } from '../i18n'

/**
 * Asked when closing a project that has unsaved changes. Mirrors the native
 * dialog the desktop app shows when quitting the app — same three choices, same
 * wording — so closing a project and quitting behave alike.
 */
export function ClosePrompt() {
  const open = useStore((s) => s.closePromptOpen)
  const busy = useStore((s) => s.busy)
  const resolve = useStore((s) => s.resolveClosePrompt)
  const projectTitle = useStore((s) => s.projectTitle)
  const projectName = useStore((s) => s.projectName)
  const t = useT()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void resolve('cancel')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, resolve])

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={() => void resolve('cancel')}>
      <div
        className="modal close-prompt"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <div className="modal-body">
          <h3>{t('prompt.close.title', { name: projectTitle || projectName })}</h3>
          <p>{t('prompt.close.body')}</p>
        </div>
        <div className="close-prompt-actions">
          <button
            type="button"
            title={t('prompt.close.cancelTitle')}
            onClick={() => void resolve('cancel')}
            disabled={busy}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            title={t('prompt.close.discardTitle')}
            onClick={() => void resolve('discard')}
            disabled={busy}
          >
            {t('prompt.close.discard')}
          </button>
          <button
            type="button"
            className="primary"
            title={t('prompt.close.saveTitle')}
            onClick={() => void resolve('save')}
            disabled={busy}
            autoFocus
          >
            {busy ? t('prompt.close.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
