import { useEffect } from 'react'
import { useStore } from '../state/store'

/**
 * Asked when closing a project that has unsaved changes. Mirrors the native
 * dialog Electron shows when quitting the app — same three choices, same
 * wording — so closing a project and quitting behave alike.
 */
export function ClosePrompt() {
  const open = useStore((s) => s.closePromptOpen)
  const busy = useStore((s) => s.busy)
  const resolve = useStore((s) => s.resolveClosePrompt)
  const projectTitle = useStore((s) => s.projectTitle)
  const projectName = useStore((s) => s.projectName)

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
          <h3>Save the changes to "{projectTitle || projectName}"?</h3>
          <p>Your changes will be lost if you don't save them.</p>
        </div>
        <div className="close-prompt-actions">
          <button type="button" onClick={() => void resolve('cancel')} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={() => void resolve('discard')} disabled={busy}>
            Don't Save
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void resolve('save')}
            disabled={busy}
            autoFocus
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
