import { useStore } from '../state/store'
import { annotationsDirProblem } from '../model/annotationsDir'

/**
 * Offered when the open project keeps its annotations in a folder that other
 * project files next to it use too. Two projects of the same kind that share a
 * paper write the very same files there, so each project gets a folder of its
 * own: this shows where every file would go and asks the reviewer to confirm
 * the ones more than one project could own.
 */
export function SplitAnnotationsDialog() {
  const split = useStore((s) => s.annotationsSplit)
  const setSplitFolder = useStore((s) => s.setSplitFolder)
  const setSplitTargets = useStore((s) => s.setSplitTargets)
  const runSplit = useStore((s) => s.runSplit)
  const dismissSplit = useStore((s) => s.dismissSplit)
  if (!split) return null

  const nameOf = new Map(split.projects.map((p) => [p.path, p.name]))
  const folderProblem = (folder: string, path: string): string | null => {
    const problem = annotationsDirProblem(folder)
    if (problem) return `Not a usable folder name: ${problem}.`
    if (folder === split.shared) return `Choose a name other than "${split.shared}".`
    if (split.projects.some((p) => p.path !== path && p.folder.toLowerCase() === folder.toLowerCase())) {
      return 'Another project already gets this folder.'
    }
    return null
  }
  const problems = split.projects.map((p) => folderProblem(p.folder, p.path))
  const count = (path: string) => split.rows.filter((r) => r.targets.includes(path)).length
  const ambiguous = split.rows.filter((r) => r.ambiguous)
  const unowned = split.rows.filter((r) => r.targets.length === 0).length

  return (
    <div className="modal-overlay">
      <div className="modal split-annotations-dialog" role="dialog" aria-modal="true" aria-label="Split the annotations folder">
        <div className="modal-head">
          <strong>Give each project its own annotations folder</strong>
        </div>
        <div className="modal-body">
          <p>
            These project files all keep their annotations in <code>{split.shared}/</code>. Two projects of the
            same kind that share a paper write the very same files there and overwrite each other&apos;s
            answers. Splitting moves each project&apos;s files into a folder of its own and records it in the
            project file. In a git repository the move shows up in the Git panel for you to commit.
          </p>
          <ul className="split-projects">
            {split.projects.map((p, i) => (
              <li key={p.path}>
                <span className="split-project-name">{p.name}</span>
                <span className="split-arrow">→</span>
                <input
                  className="field-input"
                  value={p.folder}
                  aria-label={`Annotations folder for ${p.name}`}
                  onChange={(e) => setSplitFolder(p.path, e.target.value)}
                />
                <span className="git-muted">
                  {count(p.path)} file{count(p.path) === 1 ? '' : 's'}
                </span>
                {problems[i] && <span className="split-problem">{problems[i]}</span>}
              </li>
            ))}
          </ul>

          {ambiguous.length > 0 && (
            <>
              <p>
                More than one project could own these files. Check each guess; a file copied to both is never
                lost, only duplicated.
              </p>
              <ul className="split-rows">
                {ambiguous.map((r) => (
                  <li key={r.relPath}>
                    <code>{r.relPath}</code>
                    <select
                      value={r.targets.length === 1 ? r.targets[0] : '*'}
                      aria-label={`Where ${r.relPath} goes`}
                      onChange={(e) => setSplitTargets(r.relPath, e.target.value === '*' ? r.candidates : [e.target.value])}
                    >
                      {r.candidates.map((c) => (
                        <option key={c} value={c}>
                          {nameOf.get(c)}
                        </option>
                      ))}
                      <option value="*">Copy to each</option>
                    </select>
                    <span className="git-muted">{r.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {unowned > 0 && (
            <p className="git-muted">
              {unowned} file{unowned === 1 ? '' : 's'} belong to no project here and stay in <code>{split.shared}/</code>.
            </p>
          )}
          {split.error && (
            <p className="split-problem" role="alert">
              {split.error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" onClick={dismissSplit} disabled={split.working} title="You will be asked again the next time you open this project">
              Not now
            </button>
            <button
              type="button"
              className="primary"
              disabled={split.working || problems.some(Boolean)}
              onClick={() => void runSplit()}
            >
              Split
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
