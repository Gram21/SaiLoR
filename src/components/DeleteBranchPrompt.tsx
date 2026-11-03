import { useEffect } from 'react'
import { useT, rich } from '../i18n'
import { useGitStore } from '../state/gitStore'

/**
 * The "- Delete branch…" entry's own dialog — mirrors `NewBranchPrompt`'s
 * shape, but picking from existing local branches rather than typing a name.
 * `git branch -d` (never `-D`, see `git:branchDelete`) refuses on its own when
 * the branch isn't fully merged; that refusal surfaces as the ordinary
 * `panel.error` banner once this dialog closes, rather than a second error
 * state here.
 */
export function DeleteBranchPrompt() {
  const t = useT()
  const prompt = useGitStore((s) => s.panel?.deleteBranchPrompt ?? null)
  const branches = useGitStore((s) => s.branches)
  const busy = useGitStore((s) => s.panel?.phase === 'working')
  const setBranch = useGitStore((s) => s.setDeleteBranchPromptBranch)
  const close = useGitStore((s) => s.closeDeleteBranchPrompt)
  const confirm = useGitStore((s) => s.confirmDeleteBranchPrompt)

  useEffect(() => {
    if (!prompt) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [prompt, close])

  if (!prompt) return null

  // Local branches only, current one excluded — deleting a remote-tracking
  // ref needs `git push origin --delete`, a network operation with
  // consequences for other people, out of scope here.
  const options = branches.filter((b) => !b.current && !b.remote)

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal close-prompt"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('git.deleteBranch.title')}
      >
        <div className="modal-body">
          <h3>{t('git.deleteBranch.title')}</h3>
          <select
            className="git-merge-select"
            aria-label={t('git.deleteBranch.selectLabel')}
            value={prompt.branch}
            disabled={busy}
            onChange={(e) => setBranch(e.target.value)}
            autoFocus
          >
            {options.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
          <p>{rich('git.deleteBranch.confirm', { branch: prompt.branch })}</p>
        </div>
        <div className="close-prompt-actions">
          <button type="button" onClick={close} disabled={busy} title={t('git.deleteBranch.cancelTitle')}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="primary danger"
            onClick={() => void confirm()}
            disabled={busy}
            title={t('git.deleteBranch.deleteTitle')}
          >
            {busy ? t('git.deleteBranch.deleting') : t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}
