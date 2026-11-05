// [impl->req~git-430~1]
import { useState } from 'react'
import { useT, getLanguage } from '../i18n'
import { useGitStore } from '../state/gitStore'
import { describeStash, type StashEntry } from '../git/stash'

function formatDate(date: string): string {
  const d = new Date(date)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleString(getLanguage())
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
  const t = useT()
  const stashes = useGitStore((s) => s.stashes)
  const runStashPush = useGitStore((s) => s.runStashPush)
  const runStashRestore = useGitStore((s) => s.runStashRestore)
  const runStashBranch = useGitStore((s) => s.runStashBranch)
  const runStashDrop = useGitStore((s) => s.runStashDrop)
  const [note, setNote] = useState('')

  // [impl->req~git-470~1]
  const push = async () => {
    await runStashPush(note)
    setNote('')
  }

  // [impl->req~git-470~1]
  const drop = (entry: StashEntry) => {
    const ok = window.confirm(t('git.stash.deleteConfirm', { name: describeStash(entry) }))
    if (ok) void runStashDrop(entry.sha)
  }

  return (
    <details className="git-stashes" open={stashes.length > 0}>
      <summary>
        {t('git.stash.heading')}
        {stashes.length > 0 ? ` (${stashes.length})` : ''}
      </summary>
      <p className="git-muted">{t('git.stash.explanation')}</p>
      <div className="git-stash-push">
        <input
          type="text"
          className="field-input"
          placeholder={t('git.stash.notePlaceholder')}
          value={note}
          disabled={disabled}
          onChange={(e) => setNote(e.target.value)}
          aria-label={t('git.stash.noteLabel')}
        />
        <button type="button" disabled={disabled} onClick={() => void push()} title={t('git.stash.stashTitle')}>
          {t('git.stash.stashButton')}
        </button>
      </div>

      {stashes.length > 0 && (
        <ul className="git-stash-list">
          {stashes.map((entry) => (
            <li key={entry.sha} className={`git-stash-row${entry.origin === 'branch-switch' ? ' is-stranded' : ''}`}>
              <div className="git-stash-text">
                <span className="git-stash-desc">{describeStash(entry)}</span>
                <span className="git-muted">
                  {entry.branch ? `${t('git.stash.onBranch', { branch: entry.branch })} · ` : ''}
                  {formatDate(entry.date)}
                </span>
              </div>
              <div className="git-stash-actions">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void runStashRestore(entry.sha)}
                  title={t('git.stash.restoreTitle')}
                >
                  {t('git.stash.restore')}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void runStashBranch(entry.sha)}
                  title={t('git.stash.restoreBranchTitle')}
                >
                  {t('git.stash.restoreBranch')}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={disabled}
                  onClick={() => drop(entry)}
                  title={t('git.stash.deleteTitle')}
                  aria-label={t('git.stash.deleteLabel', { name: describeStash(entry) })}
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
