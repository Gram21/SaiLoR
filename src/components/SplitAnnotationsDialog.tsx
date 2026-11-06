// [impl->req~plt-95~1]
import { useStore } from '../state/store'
import { annotationsDirProblem } from '../model/annotationsDir'
import { useT, tp, rich } from '../i18n'
import { Modal } from './Modal'

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
  const t = useT()
  if (!split) return null

  const nameOf = new Map(split.projects.map((p) => [p.path, p.name]))
  const folderProblem = (folder: string, path: string): string | null => {
    const problem = annotationsDirProblem(folder)
    if (problem) return t('split.folderInvalid', { problem })
    if (folder === split.shared) return t('split.folderShared', { folder: split.shared })
    if (split.projects.some((p) => p.path !== path && p.folder.toLowerCase() === folder.toLowerCase())) {
      return t('split.folderTaken')
    }
    return null
  }
  const problems = split.projects.map((p) => folderProblem(p.folder, p.path))
  const count = (path: string) => split.rows.filter((r) => r.targets.includes(path)).length
  const ambiguous = split.rows.filter((r) => r.ambiguous)
  const unowned = split.rows.filter((r) => r.targets.length === 0).length

  return (
    <Modal className="split-annotations-dialog" aria-label={t('split.ariaLabel')}>
      <div className="modal-head">
        <strong>{t('split.title')}</strong>
      </div>
      <div className="modal-body">
        <p>{rich('split.intro', { shared: split.shared })}</p>
        <ul className="split-projects">
          {split.projects.map((p, i) => (
            <li key={p.path}>
              <span className="split-project-name">{p.name}</span>
              <span className="split-arrow">→</span>
              <input
                className="field-input"
                value={p.folder}
                aria-label={t('split.folderAria', { name: p.name })}
                onChange={(e) => setSplitFolder(p.path, e.target.value)}
              />
              <span className="git-muted">{tp('split.files', count(p.path))}</span>
              {problems[i] && <span className="split-problem">{problems[i]}</span>}
            </li>
          ))}
        </ul>

        {ambiguous.length > 0 && (
          <>
            <p>{t('split.ambiguous')}</p>
            <ul className="split-rows">
              {ambiguous.map((r) => (
                <li key={r.relPath}>
                  <code>{r.relPath}</code>
                  <select
                    value={r.targets.length === 1 ? r.targets[0] : '*'}
                    aria-label={t('split.whereAria', { file: r.relPath })}
                    onChange={(e) => setSplitTargets(r.relPath, e.target.value === '*' ? r.candidates : [e.target.value])}
                  >
                    {r.candidates.map((c) => (
                      <option key={c} value={c}>
                        {nameOf.get(c)}
                      </option>
                    ))}
                    <option value="*">{t('split.copyToEach')}</option>
                  </select>
                  <span className="git-muted">{r.reason}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {unowned > 0 && (
          <p className="git-muted">
            {rich(unowned === 1 ? 'split.unowned_one' : 'split.unowned_other', { count: unowned, folder: split.shared })}
          </p>
        )}
        {split.error && (
          <p className="split-problem" role="alert">
            {split.error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={dismissSplit} disabled={split.working} title={t('split.notNowTitle')}>
            {t('split.notNow')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={split.working || problems.some(Boolean)}
            onClick={() => void runSplit()}
          >
            {t('split.confirm')}
          </button>
        </div>
      </div>
      
    </Modal>
  )
}
