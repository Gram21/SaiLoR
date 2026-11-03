// [impl->req~git-100~1]
import { useEffect, useState } from 'react'
import { useT } from '../i18n'
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
  const t = useT()
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
        aria-label={t('git.clone.title')}
      >
        <div className="modal-head">
          <strong>{t('git.clone.title')}</strong>
          {clone.phase !== 'cloning' && (
            <button
              type="button"
              className="icon-btn"
              onClick={requestClose}
              aria-label={t('common.close')}
              title={t('git.clone.closeTitle')}
            >
              ×
            </button>
          )}
        </div>

        <div className="modal-body">
          {clone.phase === 'setup' && (
            <>
              <label className="git-field-label" htmlFor="git-clone-url">
                {t('git.clone.url')}
              </label>
              <input
                id="git-clone-url"
                className="field-input git-clone-url-input"
                type="text"
                autoFocus
                placeholder="https://github.com/org/repo.git"
                value={clone.url}
                onChange={(e) => setCloneUrl(e.target.value)}
              />

              <div className="git-clone-dest">
                <button type="button" onClick={() => void pickCloneParent()} title={t('git.clone.chooseFolderTitle')}>
                  {t('git.clone.chooseFolder')}
                </button>
                {clone.parent ? (
                  <span className="git-clone-dest-path" title={clone.parent}>
                    {clone.parent}
                  </span>
                ) : (
                  <span className="git-clone-dest-path git-muted">{t('git.clone.noFolder')}</span>
                )}
              </div>

              {clone.parent && clone.url.trim() && (
                <p className="git-clone-preview">
                  {name
                    ? t('git.clone.willCloneInto', { path: `${clone.parent}/${name}` })
                    : t('git.clone.noRepoName')}
                </p>
              )}

              <div className="git-clone-actions">
                <button type="button" onClick={closeClone} title={t('git.clone.cancelTitle')}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!canClone}
                  onClick={() => void runClone()}
                  title={canClone ? t('git.clone.cloneTitle') : t('git.clone.cloneDisabledTitle')}
                >
                  {t('git.clone.clone')}
                </button>
              </div>
            </>
          )}

          {clone.phase === 'cloning' && (
            <div className="git-clone-progress">
              <p>
                <Spinner /> {t('git.clone.cloning', { url: clone.url })}
              </p>
              <p className="git-muted">{t('git.clone.elapsed', { seconds: elapsed })}</p>
            </div>
          )}

          {clone.phase === 'error' && (
            <>
              <p>{t('git.clone.gitError')}</p>
              <pre className="git-error">{clone.error}</pre>
              <div className="git-clone-actions">
                <button type="button" className="primary" onClick={backToCloneSetup} title={t('git.clone.backTitle')}>
                  {t('git.clone.back')}
                </button>
              </div>
            </>
          )}

          {clone.phase === 'done' && (
            <>
              <p>{t('git.clone.cloned', { dest: clone.dest ?? '' })}</p>
              <p>{t('git.clone.chooseProjectFile')}</p>
              <div className="git-clone-actions">
                <button type="button" onClick={closeClone} title={t('git.clone.cancelOpenTitle')}>
                  {t('common.cancel')}
                </button>
                <button type="button" className="primary" onClick={() => void openClonedProject()} title={t('git.clone.openTitle')}>
                  {t('common.ok')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
