import { useEffect } from 'react'
import { useGitStore } from '../state/gitStore'
import { useStore } from '../state/store'
import { diffLines } from '../git/output'
import '../styles/git.css'

/**
 * Git — changes, a diff, a commit message, Pull, Push. Shown for the open
 * project's own repository (`useGitStore().repo`), which the Toolbar's
 * **Git** button gates on.
 */
export function GitDialog() {
  const panel = useGitStore((s) => s.panel)
  const repo = useGitStore((s) => s.repo)
  const closePanel = useGitStore((s) => s.closePanel)
  const refreshStatus = useGitStore((s) => s.refreshStatus)
  const toggleSelected = useGitStore((s) => s.toggleSelected)
  const setCommitMessage = useGitStore((s) => s.setCommitMessage)
  const runCommit = useGitStore((s) => s.runCommit)
  const runPush = useGitStore((s) => s.runPush)
  const runPull = useGitStore((s) => s.runPull)
  const dismissPanelMessage = useGitStore((s) => s.dismissPanelMessage)

  const dirty = useStore((s) => s.dirty)
  const save = useStore((s) => s.save)

  useEffect(() => {
    if (!panel || panel.merge) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panel, closePanel])

  if (!panel || !repo) return null
  // The merge resolution dialog takes over from here — see GitMergeDialog.
  if (panel.merge) return null

  const working = panel.phase === 'working'
  const changes = panel.status?.changes ?? []
  const selectedCount = Object.keys(panel.selected).length
  const hasUntracked = changes.some((c) => c.code === '??')

  const requestClose = () => closePanel()

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div
        className="modal git-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Git"
      >
        <div className="modal-head">
          <strong>
            Git — {repo.branch ?? 'detached HEAD'}
            <span className="git-upstream"> ▸ {repo.upstream ?? 'no upstream'}</span>
          </strong>
          <button type="button" className="icon-btn" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {dirty && (
            <div className="git-dirty-banner">
              You have unsaved annotations. Commit and pull work on the file on disk, so save first.
              <button type="button" onClick={() => void save()}>
                Save project
              </button>
            </div>
          )}

          <div className="git-changes-head">
            <strong>Changes ({changes.length})</strong>
            <button type="button" className="icon-btn" title="Refresh" onClick={() => void refreshStatus()}>
              ↻
            </button>
          </div>

          {panel.phase === 'loading' ? (
            <p className="git-muted">Reading status…</p>
          ) : changes.length === 0 ? (
            <p className="git-muted">Nothing has changed since the last commit.</p>
          ) : (
            <ul className="git-changes">
              {changes.map((c) => (
                <li key={c.path} className="git-change-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={!!panel.selected[c.path]}
                      onChange={() => toggleSelected(c.path)}
                    />
                    <span className="git-change-code">{c.code}</span>
                    <span className="git-change-path">
                      {c.from ? `${c.from} → ${c.path}` : c.path}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {panel.status?.diff && (
            <pre className="git-diff">
              {diffLines(panel.status.diff).map((line, i) => (
                // Index is safe here: this list is a pure function of the diff
                // text and re-renders wholesale whenever it changes, never
                // reordered or edited in place.
                <span key={i} className={`git-diff-line git-diff-${line.kind}`}>
                  {line.text}
                  {'\n'}
                </span>
              ))}
            </pre>
          )}
          {panel.status?.diffTruncated && <p className="git-muted">Diff truncated.</p>}
          {hasUntracked && <p className="git-muted">Untracked files have no diff yet.</p>}

          <label className="git-field-label" htmlFor="git-commit-message">
            Commit message
          </label>
          <input
            id="git-commit-message"
            className="field-input"
            type="text"
            value={panel.message}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Describe what changed…"
          />

          <div className="git-panel-actions">
            <button
              type="button"
              className="primary"
              disabled={working || dirty || selectedCount === 0 || !panel.message.trim()}
              onClick={() => void runCommit()}
            >
              Commit
            </button>
            <div className="git-panel-actions-right">
              <button type="button" disabled={working || dirty || !repo.upstream} onClick={() => void runPull()}>
                Pull
              </button>
              <button type="button" disabled={working} onClick={() => void runPush()}>
                Push
              </button>
            </div>
          </div>

          {(panel.error || panel.notice) && (
            <div className={panel.error ? 'git-message git-message-error' : 'git-message git-message-notice'}>
              <pre className="git-message-text">{panel.error ?? panel.notice}</pre>
              <button type="button" className="icon-btn" onClick={dismissPanelMessage} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
