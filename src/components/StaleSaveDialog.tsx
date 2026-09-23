import { useStore } from '../state/store'
import type { Project } from '../model/project'
import { ConflictResolutionDialog } from './ConflictResolutionDialog'

/** How many clashing files the dialog names before it stops counting. */
const MAX_LISTED = 10

/** A clashing file (`annotations/p1/reviewer-2.json`, or the project file's own
 *  name) as the reviewer knows it: which paper, and whose part of it. */
export function describeClash(path: string, project: Project | null): string {
  const m = /^annotations\/(.+)\/([^/]+)\.json$/.exec(path)
  if (!m) return 'The project file (schema, settings, and the list of papers)'
  const [, id, name] = m
  const paper = project?.papers.find((p) => p.id === id)?.title || id
  const seat = /^(?:reviewer|screening)-(\d+)$/.exec(name)
  const marks = /^marks-(\d+)$/.exec(name)
  const part = seat
    ? `Reviewer ${seat[1]}'s answers`
    : marks
      ? `Reviewer ${marks[1]}'s PDF highlights and notes`
      : name === 'marks-consolidated'
        ? "Consolidation's PDF highlights and notes"
        : "Consolidation's answers"
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
  if (!staleSave || staleSave.dismissed) return null

  if (staleSave.merge) {
    return (
      <ConflictResolutionDialog
        merge={staleSave.merge}
        labels={{
          title: 'Combine with the changes on disk',
          intro:
            'You and the version on disk both changed these fields. Everything else has already been ' +
            "combined: a field only one side changed kept that side's value.",
          theirsValue: 'the value on disk',
          useAllTheirs: 'Use all from disk',
          cancel: 'Back',
          cancelTitle: 'Go back to choosing how to save — nothing has been saved yet',
          finish: 'Combine and save',
          finishTitle: 'Save the project with the values chosen above',
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
      <div className="modal stale-save-dialog" role="dialog" aria-modal="true" aria-label="Files changed on disk">
        <div className="modal-head">
          <strong>Someone else changed these files</strong>
        </div>
        <div className="modal-body">
          <p>
            Since you opened or last saved this project, these files were changed on disk — by a
            teammate&apos;s save in a shared folder, a git pull outside SaiLoR, or a second copy of the
            project. Nothing has been saved yet.
          </p>
          <ul className="stale-save-files">
            {listed.map((p) => (
              <li key={p} title={p}>
                {describeClash(p, project)}
              </li>
            ))}
            {rest > 0 && <li>…and {rest} more</li>}
          </ul>
          <div className="stale-save-choices">
            <button type="button" disabled={busy} onClick={() => void resolveStaleSave('overwrite')}>
              <strong>Overwrite with my version</strong>
              <span>Your version of these files replaces the one on disk. What the other person changed in them is lost.</span>
            </button>
            <button type="button" disabled={busy} onClick={() => void resolveStaleSave('discard')}>
              <strong>Keep theirs, drop my changes to these files</strong>
              <span>
                These files stay as they are on disk, and your unsaved edits to them are thrown away. Your
                edits to other files are still saved.
              </span>
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || staleSave.refusal !== null}
              onClick={() => void resolveStaleSave('combine')}
            >
              <strong>Combine both</strong>
              <span>
                Merge field by field. A field only one of you changed keeps that change; where you both
                changed the same field, you choose.
              </span>
            </button>
          </div>
          {staleSave.refusal && (
            <p className="stale-save-refusal" role="alert">
              These changes can&apos;t be combined field by field. {staleSave.refusal} Choose one of the
              other two.
            </p>
          )}
          {staleSave.error && (
            <p className="stale-save-refusal" role="alert">
              {staleSave.error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" onClick={dismissStaleSave} title="You will be asked again the next time you save">
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
