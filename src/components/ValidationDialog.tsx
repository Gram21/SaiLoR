import { useEffect, useMemo } from 'react'
import { useStore } from '../state/store'
import type { IssueKind, ValidationIssue } from '../model/validate'

const KIND_LABEL: Record<IssueKind, string> = {
  required: 'Missing',
  type: 'Wrong type',
  enum: 'Not an allowed value',
  cardinality: 'Wrong number of entries',
  screening: 'Screening',
}

/**
 * Results of "Validate": what still has to be fixed, grouped by paper.
 *
 * A paper with no annotations at all is never validated — it would fail every
 * required field for the single reason that it hasn't been started, which
 * says nothing a reviewer doesn't already know. Those papers are listed
 * separately below the issues, as a plain "not started yet" checklist.
 */
export function ValidationDialog() {
  const open = useStore((s) => s.validationOpen)
  const issues = useStore((s) => s.validation)
  const unannotated = useStore((s) => s.validationUnannotated)
  const setOpen = useStore((s) => s.setValidationOpen)
  const selectPaper = useStore((s) => s.selectPaper)

  // Group by paper, preserving the paper order validateProject walked in.
  const byPaper = useMemo(() => {
    const groups = new Map<string, { title: string; issues: ValidationIssue[] }>()
    for (const issue of issues ?? []) {
      const group = groups.get(issue.paperId) ?? { title: issue.paperTitle, issues: [] }
      group.issues.push(issue)
      groups.set(issue.paperId, group)
    }
    return [...groups.entries()]
  }, [issues])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open || !issues || !unannotated) return null

  const goToPaper = (paperId: string) => {
    selectPaper(paperId)
    setOpen(false)
  }

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div
        className="modal validation-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <strong>
            Validation{' '}
            <span className={issues.length === 0 ? 'help-mode ok' : 'help-mode bad'}>
              {issues.length === 0
                ? 'No problems'
                : `${issues.length} problem${issues.length === 1 ? '' : 's'}`}
            </span>
          </strong>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="modal-body">
          {issues.length === 0 ? (
            <p>
              {unannotated.length === 0
                ? "Every paper's annotations match the schema: required fields are filled in, values have the right type, and repeated entries are within their limits."
                : "Every paper with at least one annotation matches the schema. The papers below have none yet, so there is nothing to check."}
            </p>
          ) : (
            <>
              <p className="validation-intro">
                Click a paper to jump to it. Note that <em>Yes/no</em> fields always count as
                answered — an unticked box means <em>no</em>.
              </p>
              {byPaper.map(([paperId, group]) => (
                <section key={paperId} className="validation-group">
                  <button
                    type="button"
                    className="validation-paper"
                    onClick={() => goToPaper(paperId)}
                    title="Open this paper"
                  >
                    {group.title}
                    <span className="count">
                      {group.issues.length} problem{group.issues.length === 1 ? '' : 's'}
                    </span>
                  </button>
                  <ul className="validation-issues">
                    {group.issues.map((issue, i) => (
                      <li key={i}>
                        <span className={`validation-kind kind-${issue.kind}`}>
                          {KIND_LABEL[issue.kind]}
                        </span>
                        <span className="validation-path">{issue.path}</span>
                        <span className="validation-msg">{issue.message}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}

          {unannotated.length > 0 && (
            <section className="validation-group validation-unannotated">
              <h3 className="validation-section-title">
                Not annotated yet
                <span className="count">
                  {unannotated.length} paper{unannotated.length === 1 ? '' : 's'} — skipped, not checked
                </span>
              </h3>
              <ul className="validation-unannotated-list">
                {unannotated.map((p) => (
                  <li key={p.paperId}>
                    <button
                      type="button"
                      className="validation-paper"
                      onClick={() => goToPaper(p.paperId)}
                      title="Open this paper"
                    >
                      {p.paperTitle}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
