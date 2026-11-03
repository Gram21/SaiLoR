// [impl->req~con-520~1]
import { STRICT_MANAGER, useStore } from '../state/store'
import { personPapers, strictActive } from '../model/strict'
import { useT, tp } from '../i18n'

// [impl->req~con-450~1]
/** Blocking "Who are you?" dialog for strict mode, shown until a person or the Manager is chosen. */
export function PersonPicker() {
  const project = useStore((s) => s.project)
  const strictPerson = useStore((s) => s.strictPerson)
  const helpOpen = useStore((s) => s.helpOpen)
  const choosePerson = useStore((s) => s.choosePerson)
  const t = useT()
  if (!strictActive(project) || strictPerson !== null || helpOpen) return null

  return (
    <div className="modal-overlay" data-yields-to-help>
      <div className="modal reviewer-prompt" role="dialog" aria-modal="true" aria-labelledby="person-picker-title">
        <div className="modal-head">
          <strong id="person-picker-title">{t('strict.picker.title')}</strong>
        </div>
        <div className="modal-body">
          <p>{t('strict.picker.intro')}</p>
          <p className="reviewer-prompt-note" role="note">
            <strong>{t('strict.picker.noteLabel')}</strong> {t('editor.strict.disclaimer')}
          </p>
          <div className="reviewer-prompt-choices">
            {project.strict.persons.map((p) => {
              const count = personPapers(project, p.id).length
              return (
                <button key={p.id} type="button" className="reviewer-prompt-choice" onClick={() => choosePerson(p.id)}>
                  {p.name}
                  <span className="reviewer-prompt-ready">{tp('strict.picker.papers', count)}</span>
                </button>
              )
            })}
            <button
              type="button"
              className="reviewer-prompt-choice is-consolidation"
              onClick={() => choosePerson(STRICT_MANAGER)}
              title={t('strict.picker.managerTitle')}
            >
              {t('strict.manager')}
              <span className="reviewer-prompt-ready">{t('strict.picker.managerHint')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
