import { STRICT_MANAGER, activePerson, useStore } from '../state/store'
import { assignedSeat, personPapers, strictActive } from '../model/strict'

// [impl->req~con-480~1]
// [impl->req~con-490~1]
/** Toolbar part for strict mode: who works, Switch person and Finish. */
export function StrictPersonBar() {
  const project = useStore((s) => s.project)
  const strictPerson = useStore((s) => s.strictPerson)
  const person = useStore(activePerson)
  const dirty = useStore((s) => s.dirty)
  const busy = useStore((s) => s.busy)
  const readOnly = useStore((s) => s.readOnly)
  const switchPerson = useStore((s) => s.switchPerson)
  const finishPersonWork = useStore((s) => s.finishPersonWork)
  if (!strictActive(project) || strictPerson === null) return null

  const name =
    strictPerson === STRICT_MANAGER ? 'Manager' : (project.strict.persons.find((p) => p.id === strictPerson)?.name ?? '')
  const papers = person ? personPapers(project, person) : []
  const open = person
    ? papers.filter((id) => {
        const paper = project.papers.find((p) => p.id === id)
        return paper?.reviewsFinished[assignedSeat(project, id, person)!] !== true
      }).length
    : 0

  const finish = () => {
    const message =
      `Mark your work on all ${papers.length} assigned papers as finished and save the project? ` +
      'After the save, only the Manager can reopen the work.'
    if (window.confirm(message)) void finishPersonWork()
  }

  return (
    <div className="strict-person-bar" role="group" aria-label="Strict mode person">
      <span className="strict-person-name">Working as {name}</span>
      <button
        type="button"
        className="tb-btn"
        disabled={busy || dirty}
        title={dirty ? 'Save your changes before you switch to a different person' : 'Choose a different person'}
        onClick={switchPerson}
      >
        Switch person
      </button>
      {person && (
        <button
          type="button"
          className="tb-btn"
          disabled={busy || readOnly || open === 0}
          title={open === 0 ? 'All your assigned papers are finished' : 'Mark all your assigned papers as finished and save'}
          onClick={finish}
        >
          Finish
        </button>
      )}
    </div>
  )
}
