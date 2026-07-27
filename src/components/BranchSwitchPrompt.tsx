import { useEffect } from 'react'
import { useGitStore } from '../state/gitStore'

/**
 * Asked whenever the reviewer picks a different branch from the switcher
 * while the project has uncommitted changes — see `requestSwitchBranch` in
 * `gitStore.ts`. Mirrors `ClosePrompt`'s three-choice shape (same reason:
 * "what do you want done with my unsaved work" always deserves the same
 * three answers), but the choices themselves differ: there is no plain
 * "discard" here — carrying the changes over goes through a field-level
 * merge instead, exactly like a pull.
 */
export function BranchSwitchPrompt() {
  const prompt = useGitStore((s) => s.panel?.branchSwitchPrompt ?? null)
  const busy = useGitStore((s) => s.panel?.phase === 'working')
  const resolve = useGitStore((s) => s.resolveBranchSwitchPrompt)

  useEffect(() => {
    if (!prompt) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void resolve('cancel')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [prompt, resolve])

  if (!prompt) return null

  return (
    <div className="modal-overlay" onClick={() => void resolve('cancel')}>
      <div
        className="modal close-prompt"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <div className="modal-body">
          <h3>Switch to "{prompt.branch}"?</h3>
          <p>
            You have uncommitted changes. Commit them first (this cancels the switch for now), carry
            them into "{prompt.branch}" (merging as needed), or cancel.
          </p>
        </div>
        <div className="close-prompt-actions">
          <button type="button" onClick={() => void resolve('cancel')} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={() => void resolve('commitFirst')} disabled={busy}>
            Commit first
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void resolve('carryOver')}
            disabled={busy}
            autoFocus
          >
            {busy ? 'Switching…' : 'Carry changes over'}
          </button>
        </div>
      </div>
    </div>
  )
}
