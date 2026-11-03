// [impl->req~git-411~1]
import { useT } from '../i18n'
import { useGitStore } from '../state/gitStore'

/**
 * Asks before rewriting a `.gitattributes`/`.gitignore` the team already has.
 *
 * A repository with no such files gets SaiLoR's rules without a prompt — there
 * is nothing of anyone's to overwrite, and a dialog on first open explaining
 * line-ending normalisation is a dialog nobody reads. But once those files
 * hold rules somebody chose, changing them is not a detail: a `.gitattributes`
 * can carry LFS filters, diff drivers and export rules the whole team depends
 * on, and SaiLoR has no idea what any of it is for.
 *
 * Declining is a real answer, not a deferral to nag about later. The rules are
 * a hardening measure, not a requirement — the app works without them, it just
 * cannot protect a Windows teammate from line-ending churn or stop git
 * line-merging two reviewers' answers outside the app.
 */
export function RepoSetupPrompt() {
  const t = useT()
  const prompt = useGitStore((s) => s.repoSetupPrompt)
  const resolve = useGitStore((s) => s.resolveRepoSetup)
  if (!prompt) return null

  return (
    <div className="modal-overlay">
      <div className="modal repo-setup-prompt" role="dialog" aria-modal="true">
        <div className="modal-head">
          <strong>{t('git.repoSetup.title')}</strong>
        </div>
        <div className="modal-body">
          <p>{t('git.repoSetup.reason')}</p>
          <p>{t('git.repoSetup.willUpdate')}</p>
          <ul className="repo-setup-paths">
            {prompt.paths.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
          <p className="repo-setup-note">{t('git.repoSetup.note')}</p>
          <div className="modal-actions">
            <button type="button" onClick={() => void resolve(false)}>
              {t('git.repoSetup.decline')}
            </button>
            <button type="button" className="primary" onClick={() => void resolve(true)}>
              {t('git.repoSetup.accept')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
