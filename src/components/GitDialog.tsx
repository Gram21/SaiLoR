import { useEffect } from 'react'
import { useGitStore } from '../state/gitStore'
import { useStore } from '../state/store'
import { diffLines } from '../git/output'
import type { Disposition, FieldChange, PaperChange } from '../git/changes'
import type { FieldValue } from '../model/annotations'
import '../styles/git.css'

/**
 * Git — changes, a diff, a commit message, Pull, Push. Shown for the open
 * project's own repository (`useGitStore().repo`), which the Toolbar's
 * **Git** button gates on.
 *
 * The open project's own file gets field-level review (`panel.fieldReview`)
 * whenever it can — see `refreshFieldReview` in `gitStore.ts` for exactly
 * when that is. Every other changed file, and the project file itself when
 * it can't be reviewed field by field, keeps the plain whole-file checkbox
 * this dialog has always had.
 */
export function GitDialog() {
  const panel = useGitStore((s) => s.panel)
  const repo = useGitStore((s) => s.repo)
  const closePanel = useGitStore((s) => s.closePanel)
  const refreshStatus = useGitStore((s) => s.refreshStatus)
  const toggleSelected = useGitStore((s) => s.toggleSelected)
  const setFieldDisposition = useGitStore((s) => s.setFieldDisposition)
  const setAllFieldDispositions = useGitStore((s) => s.setAllFieldDispositions)
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
  const review = panel.fieldReview
  // The project file's own row lives in the field-review list below instead,
  // once there is one — never both.
  const changes = (panel.status?.changes ?? []).filter((c) => !review || c.path !== repo.relPath)
  const selectedCount = Object.keys(panel.selected).length
  const hasUntracked = changes.some((c) => c.code === '??')
  const reviewRowCount = review ? review.changes.fields.length + review.changes.papers.length : 0

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

          {review && (
            <>
              <div className="git-changes-head">
                <strong>Your changes to {repo.relPath} ({reviewRowCount})</strong>
                <button type="button" className="icon-btn" title="Refresh" onClick={() => void refreshStatus()}>
                  ↻
                </button>
              </div>
              <p className="git-muted">
                Use commits a field's new value. Ignore leaves it as an uncommitted change, offered
                again next time. Discard reverts it back — but only once you press Commit, never
                before.
              </p>
              <div className="git-field-review-bulk">
                <button type="button" onClick={() => setAllFieldDispositions('use')}>
                  Use all
                </button>
                <button type="button" onClick={() => setAllFieldDispositions('ignore')}>
                  Ignore all
                </button>
                <button type="button" onClick={() => setAllFieldDispositions('discard')}>
                  Discard all
                </button>
              </div>
              <ul className="git-field-rows">
                {review.changes.papers.map((pc) => (
                  <PaperChangeRow
                    key={pc.id}
                    change={pc}
                    disposition={review.decisions[pc.id] ?? 'use'}
                    onSet={(d) => setFieldDisposition(pc.id, d)}
                  />
                ))}
                {review.changes.fields.map((fc) => (
                  <FieldChangeRow
                    key={fc.id}
                    change={fc}
                    disposition={review.decisions[fc.id] ?? 'use'}
                    onSet={(d) => setFieldDisposition(fc.id, d)}
                  />
                ))}
              </ul>
            </>
          )}

          <div className="git-changes-head">
            <strong>{review ? `Other changes (${changes.length})` : `Changes (${changes.length})`}</strong>
            {!review && (
              <button type="button" className="icon-btn" title="Refresh" onClick={() => void refreshStatus()}>
                ↻
              </button>
            )}
          </div>

          {panel.phase === 'loading' ? (
            <p className="git-muted">Reading status…</p>
          ) : changes.length === 0 ? (
            <p className="git-muted">
              {review ? 'Nothing else has changed.' : 'Nothing has changed since the last commit.'}
            </p>
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
            <details className="git-diff-details">
              <summary>{review ? 'Raw diff (advanced)' : 'Diff'}</summary>
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
            </details>
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
              disabled={working || dirty || (selectedCount === 0 && !review) || !panel.message.trim()}
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

/** Matching `GitMergeDialog.tsx`'s own `formatValue` — not shared from there
 *  on purpose (see that file's comment): this dialog stays free to diverge
 *  in how it renders a value without one quietly depending on the other's
 *  private helper. */
function formatValue(value: FieldValue): string {
  if (value === undefined || value === null) return '— empty —'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' && value.trim() === '') return '— empty —'
  return String(value)
}

interface DispositionButtonsProps {
  disposition: Disposition
  onSet: (d: Disposition) => void
}

function DispositionButtons({ disposition, onSet }: DispositionButtonsProps) {
  return (
    <div className="git-field-row-actions" role="group">
      <button
        type="button"
        className={`git-disposition-btn${disposition === 'use' ? ' active' : ''}`}
        title="Commit this change"
        onClick={() => onSet('use')}
      >
        Use
      </button>
      <button
        type="button"
        className={`git-disposition-btn${disposition === 'ignore' ? ' active' : ''}`}
        title="Leave this as an uncommitted change, offered again next time"
        onClick={() => onSet('ignore')}
      >
        Ignore
      </button>
      <button
        type="button"
        className={`git-disposition-btn git-disposition-discard${disposition === 'discard' ? ' active' : ''}`}
        title="Revert this change once you press Commit"
        onClick={() => onSet('discard')}
      >
        Discard
      </button>
    </div>
  )
}

function FieldChangeRow({
  change,
  disposition,
  onSet,
}: {
  change: FieldChange
  disposition: Disposition
  onSet: (d: Disposition) => void
}) {
  return (
    <li className={`git-field-row${disposition === 'discard' ? ' is-discard' : ''}`}>
      <div className="git-field-row-head">
        <span className="git-field-row-paper">{change.paperTitle}</span>
        <span className="git-field-row-label">{change.label}</span>
      </div>
      <div className="git-field-row-values">
        <span className="git-field-row-was" title="Committed value">
          Was: {formatValue(change.headValue)}
        </span>
        <span className="git-field-row-now" title="Working copy's value">
          Now: {formatValue(change.workingValue)}
        </span>
      </div>
      <DispositionButtons disposition={disposition} onSet={onSet} />
    </li>
  )
}

function PaperChangeRow({
  change,
  disposition,
  onSet,
}: {
  change: PaperChange
  disposition: Disposition
  onSet: (d: Disposition) => void
}) {
  return (
    <li className={`git-field-row${disposition === 'discard' ? ' is-discard' : ''}`}>
      <div className="git-field-row-head">
        <span className="git-field-row-label">
          {change.kind === 'added' ? 'Paper added' : 'Paper removed'}: {change.paperTitle}
        </span>
      </div>
      <DispositionButtons disposition={disposition} onSet={onSet} />
    </li>
  )
}
