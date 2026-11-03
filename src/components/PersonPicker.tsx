import { STRICT_MANAGER, useStore } from '../state/store'
import { personPapers, strictActive } from '../model/strict'
import { STRICT_DISCLAIMER } from './StrictModeEditor'

/** Blocking "Who are you?" dialog for strict mode, shown until a person or the Manager is chosen. */
export function PersonPicker() {
  const project = useStore((s) => s.project)
  const strictPerson = useStore((s) => s.strictPerson)
  const helpOpen = useStore((s) => s.helpOpen)
  const choosePerson = useStore((s) => s.choosePerson)
  if (!strictActive(project) || strictPerson !== null || helpOpen) return null

  return (
    <div className="modal-overlay" data-yields-to-help>
      <div className="modal reviewer-prompt" role="dialog" aria-modal="true" aria-labelledby="person-picker-title">
        <div className="modal-head">
          <strong id="person-picker-title">Who are you?</strong>
        </div>
        <div className="modal-body">
          <p>
            This project uses strict mode. Each person sees only the papers assigned to them. The seat is set
            for each paper. This choice is remembered only on this computer for this project.
          </p>
          <p className="reviewer-prompt-note" role="note">
            <strong>Note:</strong> {STRICT_DISCLAIMER}
          </p>
          <div className="reviewer-prompt-choices">
            {project.strict.persons.map((p) => {
              const count = personPapers(project, p.id).length
              return (
                <button key={p.id} type="button" className="reviewer-prompt-choice" onClick={() => choosePerson(p.id)}>
                  {p.name}
                  <span className="reviewer-prompt-ready">
                    {count} {count === 1 ? 'paper' : 'papers'}
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              className="reviewer-prompt-choice is-consolidation"
              onClick={() => choosePerson(STRICT_MANAGER)}
              title="See all papers and seats, and consolidate"
            >
              Manager
              <span className="reviewer-prompt-ready">all papers and Consolidation</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
