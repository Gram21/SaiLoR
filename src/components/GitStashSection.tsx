import { useState } from 'react'
import { useGitStore } from '../state/gitStore'
import { describeStash, type StashEntry } from '../git/stash'

function formatDate(date: string): string {
  const d = new Date(date)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleString()
}

/**
 * "Stashed changes" in the Git panel: park this project's uncommitted work,
 * and see, restore or delete what is parked.
 *
 * The list is the point as much as the buttons. A stash is work outside the
 * working tree, and one nobody remembers is as good as lost — SaiLoR itself
 * makes them when it carries changes across a branch switch, and until this
 * existed a carry-over that failed to come back left no trace anywhere a
 * reviewer would look. So every stash in the repository is listed, each says
 * where it came from, and the section is open whenever there is anything in it.
 *
 * Restore is all-or-nothing (see `restoreStash`); when a stash no longer fits,
 * "Restore on a new branch" is the way through, since it cannot conflict and
 * hands any overlap to SaiLoR's own field-level merge afterwards.
 */
export function GitStashSection({ disabled }: { disabled: boolean }) {
  const stashes = useGitStore((s) => s.stashes)
  const runStashPush = useGitStore((s) => s.runStashPush)
  const runStashRestore = useGitStore((s) => s.runStashRestore)
  const runStashBranch = useGitStore((s) => s.runStashBranch)
  const runStashDrop = useGitStore((s) => s.runStashDrop)
  const [note, setNote] = useState('')

  const push = async () => {
    await runStashPush(note)
    setNote('')
  }

  const drop = (entry: StashEntry) => {
    const ok = window.confirm(
      `Delete the stash "${describeStash(entry)}"?\n\nThe changes in it are not in any file or commit, ` +
        'so they will be gone for good.',
    )
    if (ok) void runStashDrop(entry.sha)
  }

  return (
    <details className="git-stashes" open={stashes.length > 0}>
      <summary>
        Stashed changes{stashes.length > 0 ? ` (${stashes.length})` : ''}
      </summary>
      <p className="git-muted">
        Stashing parks this project's uncommitted changes — new readings included — and gives you
        back a clean copy, for example to pull or switch branches. Save first: only what is on disk
        is stashed.
      </p>
      <div className="git-stash-push">
        <input
          type="text"
          className="field-input"
          placeholder="What is this? (optional)"
          value={note}
          disabled={disabled}
          onChange={(e) => setNote(e.target.value)}
          aria-label="Note for the stash"
        />
        <button type="button" disabled={disabled} onClick={() => void push()} title="Stash this project's uncommitted changes">
          Stash my changes
        </button>
      </div>

      {stashes.length > 0 && (
        <ul className="git-stash-list">
          {stashes.map((entry) => (
            <li key={entry.sha} className={`git-stash-row${entry.origin === 'branch-switch' ? ' is-stranded' : ''}`}>
              <div className="git-stash-text">
                <span className="git-stash-desc">{describeStash(entry)}</span>
                <span className="git-muted">
                  {entry.branch ? `on ${entry.branch} · ` : ''}
                  {formatDate(entry.date)}
                </span>
              </div>
              <div className="git-stash-actions">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void runStashRestore(entry.sha)}
                  title="Put these changes back into your files and remove the stash"
                >
                  Restore
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void runStashBranch(entry.sha)}
                  title="Put these changes back on a new branch made where the stash was taken — this cannot conflict"
                >
                  Restore on a new branch
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={disabled}
                  onClick={() => drop(entry)}
                  title="Delete this stash for good"
                  aria-label={`Delete stash ${describeStash(entry)}`}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
