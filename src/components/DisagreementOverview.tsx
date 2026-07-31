import { useEffect, useMemo } from 'react'
import { useStore } from '../state/store'
import { projectVerdicts, formatValue, type FieldVerdict } from '../consolidate/disagreements'
import { paperDisagreementsText } from '../consolidate/exportDisagreements'
import { consolidationFieldStatus } from './ConsolidationVerdicts'
import { displayPath } from '../llm/paths'
import { Dropdown } from './Dropdown'
import { useExportTextMenu } from '../hooks/useExportTextMenu'

/**
 * The current paper's unresolved fields. The project-wide overview deliberately
 * shows only paper-level counts; this dialog is where their exact values are
 * inspected and resolved.
 *
 * Follows the app's modal pattern (`.modal-overlay` → `.modal` → `.modal-head`
 * + `.modal-body`, Escape-to-close, backdrop click) — see `ValidationDialog.tsx`.
 */
export function DisagreementOverview() {
  const open = useStore((s) => s.disagreementsOpen)
  const closeDisagreements = useStore((s) => s.closeDisagreements)
  const setDisagreementsOpen = useStore((s) => s.setDisagreementsOpen)
  const setConsolidationOverviewOpen = useStore((s) => s.setConsolidationOverviewOpen)
  const project = useStore((s) => s.project)
  const currentPaperId = useStore((s) => s.currentPaperId)
  const selectPaper = useStore((s) => s.selectPaper)
  const openConsolidation = useStore((s) => s.openConsolidation)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDisagreements()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, closeDisagreements])

  // Exactly the fields the annotation panel paints red, by calling the same
  // function rather than restating its rule — this list and the border beside
  // the field are two views of one verdict, and a second copy of the
  // condition is how they start disagreeing about what counts. `verdict.agree`
  // already folds in `markedEqual` (see `disagreements.ts`), so a field the
  // consolidator has declared equivalent drops out without any extra check.
  // Gated on `open` for the same reason as AgreementDialog's `built`: this
  // component stays mounted for the whole session, so an ungated memo would
  // re-walk (and re-align) every paper on every project change — every
  // annotation keystroke — for a list nobody is looking at.
  const verdicts: FieldVerdict[] = useMemo(() => {
    if (!open || !project) return []
    return projectVerdicts(project).filter(
      (verdict) =>
        verdict.paperId === currentPaperId &&
        consolidationFieldStatus(
          verdict.answeredBy.length,
          project.reviewers,
          verdict.agree,
          verdict.oneSided,
          verdict.participantCount,
        ) === 'disagree',
    )
  }, [open, project, currentPaperId])

  // Computed unconditionally (before the early return below) so it is always
  // in scope for the export hook — hooks can't follow that return themselves.
  const paper = useMemo(
    () => project?.papers.find((candidate) => candidate.id === currentPaperId),
    [project, currentPaperId],
  )
  const exportMenu = useExportTextMenu(
    () => (paper ? paperDisagreementsText(paper, verdicts) : ''),
    `${paper?.id ?? 'paper'}-disagreements.txt`,
  )

  if (!open || !project) return null

  const jumpTo = (v: FieldVerdict) => {
    selectPaper(v.paperId)
    openConsolidation(v.path, v.name, v.index, true)
    // Preserve the overview-return marker while the comparison temporarily
    // replaces this list. `closeConsolidation` restores the list, whose own
    // close action can then return to the overview.
    setDisagreementsOpen(false)
  }

  const openOverview = () => {
    closeDisagreements()
    setConsolidationOverviewOpen(true)
  }

  return (
    <div className="modal-overlay" onClick={closeDisagreements}>
      <div
        className="modal disagreement-overview"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <strong>
            Disagreements for {paper?.title ?? 'this paper'}{' '}
            <span className={verdicts.length === 0 ? 'help-mode ok' : 'help-mode bad'}>
              {verdicts.length === 0 ? 'None' : `${verdicts.length} to resolve`}
            </span>
          </strong>
          <div className="modal-head-actions">
            {exportMenu.status && <span className="export-status">{exportMenu.status}</span>}
            <Dropdown label="Export" title="Export these disagreements" items={exportMenu.items} align="right" />
            <button type="button" onClick={openOverview}>
              Overview
            </button>
            <button type="button" className="icon-btn" onClick={closeDisagreements} aria-label="Close">
              ×
            </button>
          </div>
        </div>
        <div className="modal-body">
          {verdicts.length === 0 ? (
            <p>Every field two or more reviewers answered agrees — there is nothing to reconcile on this paper.</p>
          ) : (
            <>
              <p className="disagreement-intro">Click a field to open it for consolidation.</p>
              <ul className="disagreement-rows">
                {verdicts.map((v) => (
                  <li key={v.canonical}>
                    <button
                      type="button"
                      className="disagreement-row"
                      onClick={() => jumpTo(v)}
                      title="Open this field for consolidation"
                    >
                      <span className="disagreement-path">
                        {displayPath([...v.path, { name: v.name, index: v.index }])}
                      </span>
                      <span className="disagreement-values">
                        {v.answeredBy.map((r) => (
                          <span key={r} className="disagreement-value">
                            <span className="disagreement-reviewer">R{r}</span>
                            {formatValue(v.def, v.values[r])}
                          </span>
                        ))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
