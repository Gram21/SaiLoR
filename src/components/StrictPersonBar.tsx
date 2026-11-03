import { STRICT_MANAGER, activePerson, useStore } from '../state/store'
import { assignedSeat, personPapers, strictActive } from '../model/strict'
import { useT } from '../i18n'

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
  const t = useT()
  if (!strictActive(project) || strictPerson === null) return null

  const name =
    strictPerson === STRICT_MANAGER ? t('strict.manager') : (project.strict.persons.find((p) => p.id === strictPerson)?.name ?? '')
  const papers = person ? personPapers(project, person) : []
  const open = person
    ? papers.filter((id) => {
        const paper = project.papers.find((p) => p.id === id)
        return paper?.reviewsFinished[assignedSeat(project, id, person)!] !== true
      }).length
    : 0

  const finish = () => {
    const message = t('strict.bar.finishConfirm', { count: papers.length })
    if (window.confirm(message)) void finishPersonWork()
  }

  return (
    <div className="strict-person-bar" role="group" aria-label={t('strict.bar.group')}>
      <span className="strict-person-name">{t('strict.bar.working', { name })}</span>
      <button
        type="button"
        className="tb-btn"
        disabled={busy || dirty}
        title={dirty ? t('strict.bar.switchDirty') : t('strict.bar.switchTitle')}
        onClick={switchPerson}
      >
        {t('strict.bar.switch')}
      </button>
      {person && (
        <button
          type="button"
          className="tb-btn"
          disabled={busy || readOnly || open === 0}
          title={open === 0 ? t('strict.bar.finishedAll') : t('strict.bar.finishTitle')}
          onClick={finish}
        >
          {t('strict.bar.finish')}
        </button>
      )}
    </div>
  )
}
