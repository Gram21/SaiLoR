import { useEffect, useState } from 'react'
import { useGitStore } from '../state/gitStore'
import { repoNameFromUrl } from '../git/url'
import { Spinner } from './Spinner'
import '../styles/git.css'

/**
 * Import-from-git: paste a URL, pick a destination folder, clone, then pick
 * the project JSON to open — from inside the freshly cloned repository.
 *
 * The user's request called this a "window"; the app has no secondary
 * windows anywhere (every other multi-step flow — the AI dialog, the project
 * editor's save-location step — is a modal), so a modal with four phases is
 * this app's idiom for it, not a literal new window.
 */
export function GitCloneDialog() {
  const clone = useGitStore((s) => s.clone)
  const closeClone = useGitStore((s) => s.closeClone)
  const setCloneUrl = useGitStore((s) => s.setCloneUrl)
  const pickCloneParent = useGitStore((s) => s.pickCloneParent)
  const runClone = useGitStore((s) => s.runClone)
  const backToCloneSetup = useGitStore((s) => s.backToCloneSetup)
  const openClonedProject = useGitStore((s) => s.openClonedProject)

  // Elapsed-seconds line while cloning, so a slow clone (a repo full of PDFs
  // can take minutes) reads as "working", not "frozen" — same job the AI
  // dialog's ticker does, kept local since nothing else needs this tick.
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (clone?.phase !== 'cloning') return
    const started = clone.startedAt
    setElapsed(Math.round((Date.now() - started) / 1000))
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [clone?.phase, clone?.startedAt])

  useEffect(() => {
    if (!clone || clone.phase === 'cloning') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeClone()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [clone, closeClone])

  if (!clone) return null

  const name = repoNameFromUrl(clone.url)
  const canClone = clone.url.trim() !== '' && !!clone.parent && !!name

  const requestClose = () => {
    if (clone.phase === 'cloning') return // no way out mid-clone; let it finish or fail
    closeClone()
  }

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div
        className="modal git-clone-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Import from git"
      >
        <div className="modal-head">
          <strong>Import from git</strong>
          {clone.phase !== 'cloning' && (
            <button type="button" className="icon-btn" onClick={requestClose} aria-label="Close">
              ×
            </button>
          )}
        </div>

        <div className="modal-body">
          {clone.phase === 'setup' && (
            <>
              <label className="git-field-label" htmlFor="git-clone-url">
                Repository URL
              </label>
              <input
                id="git-clone-url"
                className="field-input"
                type="text"
                autoFocus
                placeholder="https://github.com/org/repo.git"
                value={clone.url}
                onChange={(e) => setCloneUrl(e.target.value)}
              />

              <div className="git-clone-dest">
                <button type="button" onClick={() => void pickCloneParent()}>
                  Choose folder…
                </button>
                {clone.parent ? (
                  <span className="git-clone-dest-path" title={clone.parent}>
                    {clone.parent}
                  </span>
                ) : (
                  <span className="git-clone-dest-path git-muted">No folder chosen yet</span>
                )}
              </div>

              {clone.parent && clone.url.trim() && (
                <p className="git-clone-preview">
                  {name
                    ? `Will clone into: ${clone.parent}/${name}`
                    : 'That URL has no repository name in it.'}
                </p>
              )}

              <div className="git-clone-actions">
                <button type="button" onClick={closeClone}>
                  Cancel
                </button>
                <button type="button" className="primary" disabled={!canClone} onClick={() => void runClone()}>
                  Clone
                </button>
              </div>
            </>
          )}

          {clone.phase === 'cloning' && (
            <div className="git-clone-progress">
              <p>
                <Spinner /> Cloning {clone.url}…
              </p>
              <p className="git-muted">{elapsed}s elapsed — a repository full of PDFs can take a while.</p>
            </div>
          )}

          {clone.phase === 'error' && (
            <>
              <p>Git reported an error:</p>
              <pre className="git-error">{clone.error}</pre>
              <div className="git-clone-actions">
                <button type="button" className="primary" onClick={backToCloneSetup}>
                  Back
                </button>
              </div>
            </>
          )}

          {clone.phase === 'done' && (
            <>
              <p>Cloned into {clone.dest}.</p>
              <p>Now choose the project JSON to open — the file picker will start there.</p>
              <div className="git-clone-actions">
                <button type="button" onClick={closeClone}>
                  Cancel
                </button>
                <button type="button" className="primary" onClick={() => void openClonedProject()}>
                  OK
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
