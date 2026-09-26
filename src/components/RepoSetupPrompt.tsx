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
  const prompt = useGitStore((s) => s.repoSetupPrompt)
  const resolve = useGitStore((s) => s.resolveRepoSetup)
  if (!prompt) return null

  return (
    <div className="modal-overlay">
      <div className="modal repo-setup-prompt" role="dialog" aria-modal="true">
        <div className="modal-head">
          <strong>Configure this repository for SaiLoR?</strong>
        </div>
        <div className="modal-body">
          <p>
            Two of git's defaults work against annotation data. On Windows, git normally rewrites
            every line ending on checkout, which turns one reviewer's machine into a source of
            whole-file diffs and phantom conflicts for everyone. And git's own merge will combine
            two reviewers' answers into a file that is valid JSON but that neither of them wrote —
            SaiLoR never uses that result, but anyone merging in a terminal gets it silently.
          </p>
          <p>
            SaiLoR can add rules that fix both, plus ignore the OS junk files that otherwise block
            a merge by sitting untracked in the annotations folder. It would update:
          </p>
          <ul className="repo-setup-paths">
            {prompt.paths.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
          <p className="repo-setup-note">
            These files already have rules of their own. SaiLoR's go in a clearly marked block and
            nothing outside it is touched, but they are yours — if anything in them is deliberate,
            say no and add the rules by hand. The change is committed, authored as SaiLoR.
          </p>
          <div className="modal-actions">
            <button type="button" onClick={() => void resolve(false)}>
              No, leave them alone
            </button>
            <button type="button" className="primary" onClick={() => void resolve(true)}>
              Add SaiLoR's rules
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
