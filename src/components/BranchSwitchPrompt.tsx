import { useEffect } from 'react'
import { useT } from '../i18n'
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
  const t = useT()
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
          <h3>{t('git.branchSwitch.title', { branch: prompt.branch })}</h3>
          <p>{t('git.branchSwitch.body', { branch: prompt.branch })}</p>
        </div>
        <div className="close-prompt-actions">
          <button
            type="button"
            title={t('git.branchSwitch.cancelTitle')}
            onClick={() => void resolve('cancel')}
            disabled={busy}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            title={t('git.branchSwitch.commitFirstTitle')}
            onClick={() => void resolve('commitFirst')}
            disabled={busy}
          >
            {t('git.branchSwitch.commitFirst')}
          </button>
          <button
            type="button"
            className="primary"
            title={t('git.branchSwitch.carryOverTitle', { branch: prompt.branch })}
            onClick={() => void resolve('carryOver')}
            disabled={busy}
            autoFocus
          >
            {busy ? t('git.branchSwitch.switching') : t('git.branchSwitch.carryOver')}
          </button>
        </div>
      </div>
    </div>
  )
}
