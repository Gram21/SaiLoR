import { useEffect } from 'react'
import { useGitStore } from '../state/gitStore'
import type { GitBranch } from '../git/types'

/**
 * The "Merge branch…" button's dialog — pick a branch, see plainly which
 * direction the merge goes ("Merge X into the current branch Y"), confirm.
 * Deliberately its own small prompt rather than the header's branch switcher
 * or an inline control next to Pull/Push: merging is a rare, explicit choice,
 * not something a reviewer reaches for every session, so it earns its own
 * button instead of crowding the controls used every time.
 *
 * Confirming hands `branch` to `runMergeBranch`, whose own outcome (a notice,
 * an error, or `GitMergeDialog` taking over for a real conflict) is shown in
 * the ordinary Git panel exactly as if Pull had produced it.
 */
export function MergeBranchPrompt() {
  const prompt = useGitStore((s) => s.panel?.mergeBranchPrompt ?? null)
  const repo = useGitStore((s) => s.repo)
  const branches = useGitStore((s) => s.branches)
  const busy = useGitStore((s) => s.panel?.phase === 'working')
  const setBranch = useGitStore((s) => s.setMergeBranchPromptBranch)
  const close = useGitStore((s) => s.closeMergeBranchPrompt)
  const confirm = useGitStore((s) => s.confirmMergeBranchPrompt)

  useEffect(() => {
    if (!prompt) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [prompt, close])

  if (!prompt || !repo) return null

  // Every branch but the one already checked out — merging a branch into
  // itself is not a choice worth offering.
  const mergeable = branches.filter((b) => !b.current)

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal close-prompt"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Merge branch"
      >
        <div className="modal-body">
          <h3>Merge branch</h3>
          <label className="git-field-label" htmlFor="merge-branch-select">
            Branch to merge
          </label>
          <select
            id="merge-branch-select"
            className="git-merge-select"
            value={prompt.branch}
            disabled={busy}
            onChange={(e) => setBranch(e.target.value)}
            autoFocus
          >
            <MergeBranchOptions branches={mergeable} remote={false} label="Local" />
            <MergeBranchOptions branches={mergeable} remote={true} label="Remote" />
          </select>
          <p>
            Merge <strong>{prompt.branch}</strong> into the current branch <strong>{repo.branch}</strong>. Field-level
            conflicts, if any, are shown before anything is committed.
          </p>
        </div>
        <div className="close-prompt-actions">
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Merging…' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One namespace of the picker, or nothing at all when that namespace is
 *  empty — an `<optgroup>` with no options still renders its label, which
 *  would show a "Remote" heading in every repository that has no remote. */
function MergeBranchOptions({
  branches,
  remote,
  label,
}: {
  branches: GitBranch[]
  remote: boolean
  label: string
}) {
  const rows = branches.filter((b) => b.remote === remote)
  if (rows.length === 0) return null
  return (
    <optgroup label={label}>
      {rows.map((b) => (
        <option key={b.name} value={b.name}>
          {b.name}
        </option>
      ))}
    </optgroup>
  )
}
