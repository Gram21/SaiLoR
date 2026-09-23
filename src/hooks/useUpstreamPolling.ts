import { useEffect } from 'react'
import { useGitStore } from '../state/gitStore'
import { BACKGROUND_FETCH_INTERVAL_MS } from '../git/fetchPolicy'

/**
 * Keeps the toolbar's "↓ N to pull" fresh while a project in a repository with
 * an upstream is open, by fetching every two minutes (`refreshUpstream`, which
 * also runs once when the repository is detected and whenever the Git panel
 * opens).
 *
 * Without it the count was only as fresh as the last time the project was
 * opened, so a reviewer could work for an hour against a remote that had moved
 * on and find out only when their pull conflicted.
 *
 * Keyed on the repository root and upstream, not on the `repo` object, which
 * is replaced on every reload — restarting the timer each time would also
 * restart the two-minute wait.
 */
export function useUpstreamPolling(): void {
  const root = useGitStore((s) => s.repo?.root ?? null)
  const upstream = useGitStore((s) => s.repo?.upstream ?? null)
  const refreshUpstream = useGitStore((s) => s.refreshUpstream)

  useEffect(() => {
    if (!root || !upstream) return
    const t = window.setInterval(() => void refreshUpstream(), BACKGROUND_FETCH_INTERVAL_MS)
    return () => window.clearInterval(t)
  }, [root, upstream, refreshUpstream])
}
