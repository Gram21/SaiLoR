import { useEffect, useRef } from 'react'
import { useGitStore } from '../state/gitStore'

/**
 * The branch switcher's "New branch…" entry: a name, created at the current
 * commit (`git branch`), then handed straight to the ordinary
 * `requestSwitchBranch` flow — carrying uncommitted changes over into a
 * branch that was just cut from here can never itself conflict, so it works
 * exactly like switching to any other branch.
 */
export function NewBranchPrompt() {
  const prompt = useGitStore((s) => s.panel?.newBranchPrompt ?? null)
  const busy = useGitStore((s) => s.panel?.phase === 'working')
  const setName = useGitStore((s) => s.setNewBranchName)
  const close = useGitStore((s) => s.closeNewBranchPrompt)
  const create = useGitStore((s) => s.createAndSwitchBranch)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!prompt) return
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [prompt, close])

  if (!prompt) return null

  const submit = () => {
    if (!busy && prompt.name.trim()) void create()
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal close-prompt"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="New branch"
      >
        <div className="modal-body">
          <h3>New branch</h3>
          <p>Created at the current commit, and switched to right away — carrying over any uncommitted changes.</p>
          <input
            ref={inputRef}
            className="field-input"
            type="text"
            value={prompt.name}
            placeholder="branch-name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
          {prompt.error && <p className="git-message-text git-message-error">{prompt.error}</p>}
        </div>
        <div className="close-prompt-actions">
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={submit}
            disabled={busy || !prompt.name.trim()}
            autoFocus
          >
            {busy ? 'Creating…' : 'Create and switch'}
          </button>
        </div>
      </div>
    </div>
  )
}
