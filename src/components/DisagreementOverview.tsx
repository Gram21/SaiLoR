// [impl->req~con-430~1]
import { useEffect, useMemo } from 'react'
import { useStore } from '../state/store'
import { projectVerdicts, formatValue, type FieldVerdict } from '../consolidate/disagreements'
import { paperDisagreementsText } from '../consolidate/exportDisagreements'
import { consolidationFieldStatus } from './ConsolidationVerdicts'
import { displayPath } from '../llm/paths'
import { Dropdown } from './Dropdown'
import { useExportTextMenu } from '../hooks/useExportTextMenu'
import { useT } from '../i18n'
import { Modal } from './Modal'

/**
 * The current paper's unresolved fields. The project-wide overview deliberately
 * shows only paper-level counts; this dialog is where their exact values are
 * inspected and resolved.
 *
 * Follows the app's modal pattern (`.modal-overlay` → `.modal` → `.modal-head`
 * + `.modal-body`, Escape-to-close, backdrop click) — see `ValidationDialog.tsx`.
 */
export function DisagreementOverview() {
  const t = useT()
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
    // [impl->req~con-230~1]
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
  // [impl->req~con-230~1]
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
    <Modal onClose={closeDisagreements} className="disagreement-overview">
      <div className="modal-head">
        <strong>
          {t('consolidation.disagreements.title', { title: paper?.title ?? t('consolidation.disagreements.thisPaper') })}{' '}
          <span className={verdicts.length === 0 ? 'help-mode ok' : 'help-mode bad'}>
            {verdicts.length === 0
              ? t('consolidation.disagreements.none')
              : t('consolidation.disagreements.toResolve', { count: verdicts.length })}
          </span>
        </strong>
        <div className="modal-head-actions">
          {exportMenu.status && <span className="export-status">{exportMenu.status}</span>}
          <Dropdown
            label={t('consolidation.export')}
            title={t('consolidation.disagreements.exportTitle')}
            items={exportMenu.items}
            align="right"
          />
          <button type="button" title={t('consolidation.disagreements.overviewTitle')} onClick={openOverview}>
            {t('consolidation.disagreements.overview')}
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t('common.close')}
            onClick={closeDisagreements}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>
      </div>
      <div className="modal-body">
        {verdicts.length === 0 ? (
          <p>{t('consolidation.disagreements.allAgree')}</p>
        ) : (
          <>
            <p className="disagreement-intro">{t('consolidation.disagreements.intro')}</p>
            <ul className="disagreement-rows">
              {verdicts.map((v) => (
                <li key={v.canonical}>
                  <button
                    type="button"
                    className="disagreement-row"
                    onClick={() => jumpTo(v)}
                    title={t('consolidation.disagreements.openField')}
                  >
                    <span className="disagreement-path">
                      {displayPath([...v.path, { name: v.name, index: v.index }])}
                    </span>
                    <span className="disagreement-values">
                      {v.answeredBy.map((r) => (
                        <span key={r} className="disagreement-value">
                          <span className="disagreement-reviewer">{t('consolidation.disagreements.reviewer', { id: r })}</span>
                          {formatValue(v.def, v.values[r])}
                        </span>
                      ))}
                      {v.onlyIn.length > 0 && (
                        <span className="disagreement-only">
                          {t('consolidation.onlyIn', {
                            reviewers: v.onlyIn.map((r) => t('consolidation.disagreements.reviewer', { id: r })).join(', '),
                          })}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      
    </Modal>
  )
}
