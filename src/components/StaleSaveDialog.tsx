import { useStore } from '../state/store'
import { seatLabel, type Project } from '../model/project'
import { DEFAULT_ANNOTATIONS_DIR } from '../model/annotationsDir'
import { ConflictResolutionDialog } from './ConflictResolutionDialog'
import { t, useT } from '../i18n'

// [impl->req~plt-135~1]
/** How many clashing files the dialog names before it stops counting. */
const MAX_LISTED = 10

/** A clashing file (`annotations/p1/reviewer-2.json`, or the project file's own
 *  name) as the reviewer knows it: which paper, and whose part of it. */
export function describeClash(path: string, project: Project | null): string {
  const folder = `${project?.annotationsDir ?? DEFAULT_ANNOTATIONS_DIR}/`
  const m = path.startsWith(folder) ? /^(.+)\/([^/]+)\.json$/.exec(path.slice(folder.length)) : null
  if (!m) return t('app.clash.projectFile')
  const [, id, name] = m
  const paper = project?.papers.find((p) => p.id === id)?.title || id
  const seat = /^(?:reviewer|screening)-(\d+)$/.exec(name)
  const marks = /^(?:screening-)?marks-(\d+)$/.exec(name)
  // [impl->req~plt-136~1]
  const part = seat
    ? t('app.clash.answers', { seat: project ? seatLabel(project, seat[1]) : t('toolbar.reviewer.name', { n: seat[1] }) })
    : marks
      ? t('app.clash.marks', { seat: project ? seatLabel(project, marks[1]) : t('toolbar.reviewer.name', { n: marks[1] }) })
      : /^(?:screening-)?marks-consolidated$/.test(name)
        ? t('app.clash.consolidatedMarks')
        : t('app.clash.consolidatedAnswers')
  return `${paper} — ${part}`
}

/**
 * Asked when a save finds that files it would overwrite changed on disk since
 * the project was opened or last saved — a teammate's save on a shared folder,
 * a pull run in a terminal. Nothing has been written; the reviewer decides
 * whose version of those files wins, or combines the two field by field.
 */
export function StaleSaveDialog() {
  const staleSave = useStore((s) => s.staleSave)
  const project = useStore((s) => s.project)
  const busy = useStore((s) => s.busy)
  const resolveStaleSave = useStore((s) => s.resolveStaleSave)
  const resolveStaleConflict = useStore((s) => s.resolveStaleConflict)
  const takeAllStaleConflicts = useStore((s) => s.takeAllStaleConflicts)
  const finishStaleCombine = useStore((s) => s.finishStaleCombine)
  const backToStaleChoice = useStore((s) => s.backToStaleChoice)
  const dismissStaleSave = useStore((s) => s.dismissStaleSave)
  const dismissStaleSaveError = useStore((s) => s.dismissStaleSaveError)
  const t = useT()
  if (!staleSave || staleSave.dismissed) return null

  if (staleSave.merge) {
    return (
      <ConflictResolutionDialog
        merge={staleSave.merge}
        labels={{
          title: t('app.staleSave.merge.title'),
          intro: t('app.staleSave.merge.intro'),
          theirsValue: t('app.staleSave.merge.theirsValue'),
          useAllTheirs: t('app.staleSave.merge.useAll'),
          cancel: t('app.staleSave.merge.back'),
          cancelTitle: t('app.staleSave.merge.backTitle'),
          finish: t('app.staleSave.merge.finish'),
          finishTitle: t('app.staleSave.merge.finishTitle'),
        }}
        error={staleSave.error}
        onResolve={resolveStaleConflict}
        onTakeAll={takeAllStaleConflicts}
        onFinish={() => void finishStaleCombine()}
        onCancel={backToStaleChoice}
        onDismissError={dismissStaleSaveError}
      />
    )
  }

  const listed = staleSave.paths.slice(0, MAX_LISTED)
  const rest = staleSave.paths.length - listed.length

  return (
    <div className="modal-overlay">
      <div className="modal stale-save-dialog" role="dialog" aria-modal="true" aria-label={t('app.staleSave.aria')}>
        <div className="modal-head">
          <strong>{t('app.staleSave.title')}</strong>
        </div>
        <div className="modal-body">
          <p>{t('app.staleSave.body')}</p>
          <ul className="stale-save-files">
            {listed.map((p) => (
              <li key={p} title={p}>
                {describeClash(p, project)}
              </li>
            ))}
            {rest > 0 && <li>{t('app.staleSave.more', { count: rest })}</li>}
          </ul>
          <div className="stale-save-choices">
            <button type="button" disabled={busy} onClick={() => void resolveStaleSave('overwrite')}>
              <strong>{t('app.staleSave.overwrite')}</strong>
              <span>{t('app.staleSave.overwriteHint')}</span>
            </button>
            <button type="button" disabled={busy} onClick={() => void resolveStaleSave('discard')}>
              <strong>{t('app.staleSave.discard')}</strong>
              <span>{t('app.staleSave.discardHint')}</span>
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || staleSave.refusal !== null}
              onClick={() => void resolveStaleSave('combine')}
            >
              <strong>{t('app.staleSave.combine')}</strong>
              <span>{t('app.staleSave.combineHint')}</span>
            </button>
          </div>
          {staleSave.refusal && (
            <p className="stale-save-refusal" role="alert">
              {t('app.staleSave.refusal', { reason: staleSave.refusal })}
            </p>
          )}
          {staleSave.error && (
            <p className="stale-save-refusal" role="alert">
              {staleSave.error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" onClick={dismissStaleSave} title={t('app.staleSave.laterTitle')}>
              {t('app.staleSave.later')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
