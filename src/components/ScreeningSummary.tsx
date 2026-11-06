// [impl->req~scr-210~1]
import { useEffect } from 'react'
import { useStore } from '../state/store'
import { screeningCounts } from '../screening/counts'
import { useT } from '../i18n'
import { Modal } from './Modal'

/**
 * Progress and PRISMA-style counts for a screening project — the include /
 * exclude / undecided totals and the excluded-by-reason breakdown reviewers
 * have to report. Follows the `ValidationDialog` modal pattern: `.modal-overlay`
 * → `.modal` → `.modal-head` + `.modal-body`, Escape-to-close, backdrop click.
 */
export function ScreeningSummary() {
  const t = useT()
  const open = useStore((s) => s.screeningSummaryOpen)
  const setOpen = useStore((s) => s.setScreeningSummaryOpen)
  const project = useStore((s) => s.project)
  const currentReviewer = useStore((s) => s.currentReviewer)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open || !project || !project.screening) return null

  const counts = screeningCounts(project, currentReviewer)
  const reasons = project.screening.reasons
  const seatLabel =
    project.reviewers <= 1
      ? t('screening.summary.seatAll')
      : currentReviewer === 'consolidation'
        ? t('screening.summary.seatConsolidated')
        : currentReviewer
          ? t('screening.summary.seatReviewer', { id: currentReviewer })
          : t('screening.summary.seatNone')

  return (
    <Modal onClose={() => setOpen(false)} className="screening-summary">
      <div className="modal-head">
        <strong>{t('screening.summary.title')}</strong>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setOpen(false)}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          ×
        </button>
      </div>
      <div className="modal-body">
        <p className="screening-summary-seat">{t('screening.summary.counting', { seat: seatLabel })}</p>
        <div className="screening-summary-headline">
          <div>
            <strong>{counts.total}</strong>
            <span>{t('screening.summary.total')}</span>
          </div>
          <div>
            <strong>{counts.included}</strong>
            <span>{t('screening.summary.included')}</span>
          </div>
          <div>
            <strong>{counts.excluded}</strong>
            <span>{t('screening.summary.excluded')}</span>
          </div>
          <div>
            <strong>{counts.undecided}</strong>
            <span>{t('screening.summary.undecided')}</span>
          </div>
        </div>
        <table className="screening-summary-table">
          <thead>
            <tr>
              <th>{t('screening.summary.reason')}</th>
              <th>{t('screening.summary.papers')}</th>
            </tr>
          </thead>
          <tbody>
            {reasons.map((reason) => (
              <tr key={reason}>
                <td>{reason}</td>
                <td>{counts.byReason[reason] ?? 0}</td>
              </tr>
            ))}
            {counts.excludedWithoutReason > 0 && (
              <tr className="screening-summary-unknown">
                <td>{t('screening.summary.noReason')}</td>
                <td>{counts.excludedWithoutReason}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      
    </Modal>
  )
}
