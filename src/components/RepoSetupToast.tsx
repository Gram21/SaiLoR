import { useEffect } from 'react'
import { useGitStore } from '../state/gitStore'

/** How long a success stays up before it goes by itself. */
const AUTO_DISMISS_MS = 6000

/**
 * A small corner popup saying SaiLoR configured the repository.
 *
 * It has to be said — the rules land in a commit the reviewer never typed —
 * but it is a statement of fact, not something to act on, so it should not
 * take up room in the toolbar or stay there. A success fades on its own. A
 * failure does not: configuring the repository is optional, but a reviewer
 * should still see why it did not happen rather than have it vanish.
 */
export function RepoSetupToast() {
  const notice = useGitStore((s) => s.repoSetupNotice)
  const dismiss = useGitStore((s) => s.dismissRepoSetupNotice)

  useEffect(() => {
    if (notice?.kind !== 'ok') return
    const t = window.setTimeout(dismiss, AUTO_DISMISS_MS)
    return () => window.clearTimeout(t)
  }, [notice, dismiss])

  if (!notice) return null
  return (
    <div className={`toast${notice.kind === 'error' ? ' toast-error' : ''}`} role="status">
      <span className="toast-text">{notice.text}</span>
      <button type="button" className="icon-btn" onClick={dismiss} title="Dismiss" aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
