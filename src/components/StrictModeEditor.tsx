// [impl->req~con-520~1]
import { useState } from 'react'
import { editorSeatFinished, useEditorStore } from '../state/editorStore'
import { aiSeatId } from '../model/project'
import { personCounts } from '../model/strict'
import { useT } from '../i18n'

// [impl->req~edt-130~1]
// [impl->req~edt-140~1]
// [impl->req~edt-160~1]
// [impl->req~edt-170~1]
/** Persons, their paper assignments and their finished work, for strict mode. */
export function StrictModeEditor() {
  const t = useT()
  const strict = useEditorStore((s) => s.strict)
  const papers = useEditorStore((s) => s.papers)
  const reviewers = useEditorStore((s) => s.reviewers)
  const aiSeat = useEditorStore((s) => s.aiSeat)
  const aiEnabled = useEditorStore((s) => s.aiEnabled)
  const busy = useEditorStore((s) => s.busy)
  const setStrictEnabled = useEditorStore((s) => s.setStrictEnabled)
  const addPerson = useEditorStore((s) => s.addPerson)
  const renamePerson = useEditorStore((s) => s.renamePerson)
  const removePerson = useEditorStore((s) => s.removePerson)
  const setAssignment = useEditorStore((s) => s.setAssignment)
  const bulkAssignStrict = useEditorStore((s) => s.bulkAssignStrict)
  const reopenWork = useEditorStore((s) => s.reopenWork)
  const [perPaper, setPerPaper] = useState(2)

  const persons = strict?.persons ?? []
  const ai = aiSeatId({ aiSeat, aiEnabled, reviewers, screening: null })
  const seats = Array.from({ length: reviewers }, (_, i) => i + 1)
  const humanSeats = seats.filter((n) => String(n) !== ai).length
  const maxPerPaper = Math.max(1, Math.min(persons.length, humanSeats))
  const byUid = new Map(papers.map((p) => [p.uid, p]))
  const counts = strict
    ? personCounts(strict, reviewers, (uid, seat) => editorSeatFinished(byUid.get(uid), seat))
    : {}

  return (
    <section className="editor-section strict-editor">
      <details className="editor-protocol-details" open={strict?.enabled === true}>
        <summary>
          <h2>{t('editor.strict.title')}</h2>
          <span className="editor-protocol-summary-hint">
            {strict?.enabled ? t('editor.strict.on') : t('editor.project.optional')}
          </span>
        </summary>
        <p className="editor-hint">{t('editor.strict.hint')}</p>
        <p className="editor-hint" role="note">
          <strong>{t('editor.strict.note')}</strong> {t('editor.strict.disclaimer')}
        </p>
        <label className="editor-ai-toggle">
          <input
            type="checkbox"
            checked={strict?.enabled === true}
            disabled={busy}
            onChange={(e) => setStrictEnabled(e.target.checked)}
          />
          <span>{t('editor.strict.useToggle')}</span>
        </label>

        <h3>{t('editor.strict.persons')}</h3>
        <ul className="strict-persons">
          {persons.map((p) => (
            <li key={p.id} className="strict-person">
              <input
                className="protocol-input"
                aria-label={t('editor.strict.personName', { id: p.id })}
                value={p.name}
                disabled={busy}
                onChange={(e) => renamePerson(p.id, e.target.value)}
              />
              <span className="editor-hint">
                {t('editor.strict.counts', { assigned: counts[p.id]?.assigned ?? 0, finished: counts[p.id]?.finished ?? 0 })}
              </span>
              <button
                type="button"
                disabled={busy}
                title={t('editor.strict.removePersonTitle')}
                onClick={() => removePerson(p.id)}
              >
                {t('common.remove')}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" disabled={busy} onClick={addPerson}>
          {t('editor.strict.addPerson')}
        </button>

        {persons.length > 0 && papers.length > 0 && (
          <>
            <h3>{t('editor.strict.assignments')}</h3>
            <div className="strict-bulk">
              <label>
                {t('editor.strict.personsPerPaper')}{' '}
                <input
                  type="number"
                  min={1}
                  max={maxPerPaper}
                  value={Math.min(perPaper, maxPerPaper)}
                  onChange={(e) => setPerPaper(Number(e.target.value) || 1)}
                />
              </label>
              <button
                type="button"
                disabled={busy}
                title={t('editor.strict.assignTitle')}
                onClick={() => bulkAssignStrict(Math.min(perPaper, maxPerPaper))}
              >
                {t('editor.strict.assignButton')}
              </button>
            </div>
            <table className="strict-assignments">
              <thead>
                <tr>
                  <th>{t('editor.strict.paper')}</th>
                  {seats.map((n) => (
                    <th key={n}>
                      {String(n) === ai ? t('editor.strict.aiSeatHeader', { n }) : t('editor.strict.seatHeader', { n })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {papers.map((paper) => (
                  <tr key={paper.uid}>
                    <td title={paper.title}>{paper.id || paper.title || t('editor.strict.noId')}</td>
                    {seats.map((n) => {
                      const current = strict?.assignments[paper.uid]?.find((a) => a.seat === n)
                      const finished = current !== undefined && editorSeatFinished(paper, n)
                      return (
                        <td key={n}>
                          <select
                            aria-label={t('editor.strict.personForSeat', { id: paper.id, n })}
                            value={current?.person ?? ''}
                            disabled={busy || finished}
                            onChange={(e) => setAssignment(paper.uid, n, e.target.value || null)}
                          >
                            <option value="">{t('editor.strict.none')}</option>
                            {persons.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                          {finished && (
                            <button
                              type="button"
                              disabled={busy}
                              title={t('editor.strict.reopenTitle')}
                              onClick={() => reopenWork(paper.uid, n)}
                            >
                              {t('editor.strict.reopen')}
                            </button>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </details>
    </section>
  )
}
