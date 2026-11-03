// [impl->req~con-520~1]
import { useState } from 'react'
import { editorSeatFinished, useEditorStore } from '../state/editorStore'
import { aiSeatId } from '../model/project'
import { personCounts } from '../model/strict'

export const STRICT_DISCLAIMER =
  'Strict mode is a workflow aid, not security. Anyone can pick a different person or edit the files.'

// [impl->req~edt-130~1]
// [impl->req~edt-140~1]
// [impl->req~edt-160~1]
// [impl->req~edt-170~1]
/** Persons, their paper assignments and their finished work, for strict mode. */
export function StrictModeEditor() {
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
          <h2>Strict mode</h2>
          <span className="editor-protocol-summary-hint">{strict?.enabled ? 'on' : 'optional'}</span>
        </summary>
        <p className="editor-hint">
          Each person sees only the papers assigned to them, on a fixed seat. Consolidation of a paper opens when
          every assigned person has finished it.
        </p>
        <p className="editor-hint" role="note">
          <strong>Note:</strong> {STRICT_DISCLAIMER}
        </p>
        <label className="editor-ai-toggle">
          <input
            type="checkbox"
            checked={strict?.enabled === true}
            disabled={busy}
            onChange={(e) => setStrictEnabled(e.target.checked)}
          />
          <span>Use strict mode</span>
        </label>

        <h3>Persons</h3>
        <ul className="strict-persons">
          {persons.map((p) => (
            <li key={p.id} className="strict-person">
              <input
                className="protocol-input"
                aria-label={`Name of person ${p.id}`}
                value={p.name}
                disabled={busy}
                onChange={(e) => renamePerson(p.id, e.target.value)}
              />
              <span className="editor-hint">
                {counts[p.id]?.assigned ?? 0} assigned, {counts[p.id]?.finished ?? 0} finished
              </span>
              <button
                type="button"
                disabled={busy}
                title="Remove this person. Refused if the person has finished work."
                onClick={() => removePerson(p.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <button type="button" disabled={busy} onClick={addPerson}>
          Add person
        </button>

        {persons.length > 0 && papers.length > 0 && (
          <>
            <h3>Assignments</h3>
            <div className="strict-bulk">
              <label>
                Persons per paper{' '}
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
                title="Assign persons in turn to every paper that has no assignment yet. The AI seat is not used."
                onClick={() => bulkAssignStrict(Math.min(perPaper, maxPerPaper))}
              >
                Assign papers without persons
              </button>
            </div>
            <table className="strict-assignments">
              <thead>
                <tr>
                  <th>Paper</th>
                  {seats.map((n) => (
                    <th key={n}>{String(n) === ai ? `AI (Reviewer ${n})` : `Reviewer ${n}`}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {papers.map((paper) => (
                  <tr key={paper.uid}>
                    <td title={paper.title}>{paper.id || paper.title || '(no id)'}</td>
                    {seats.map((n) => {
                      const current = strict?.assignments[paper.uid]?.find((a) => a.seat === n)
                      const finished = current !== undefined && editorSeatFinished(paper, n)
                      return (
                        <td key={n}>
                          <select
                            aria-label={`Person for ${paper.id} seat ${n}`}
                            value={current?.person ?? ''}
                            disabled={busy || finished}
                            onChange={(e) => setAssignment(paper.uid, n, e.target.value || null)}
                          >
                            <option value="">None</option>
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
                              title="Remove the finished flag so the person can work on this paper again."
                              onClick={() => reopenWork(paper.uid, n)}
                            >
                              Reopen
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
