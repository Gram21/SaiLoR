import { useEffect } from 'react'
import { useStore } from '../state/store'
import { screeningCounts } from '../screening/counts'

/**
 * Progress and PRISMA-style counts for a screening project — the include /
 * exclude / undecided totals and the excluded-by-reason breakdown reviewers
 * have to report. Follows the `ValidationDialog` modal pattern: `.modal-overlay`
 * → `.modal` → `.modal-head` + `.modal-body`, Escape-to-close, backdrop click.
 */
export function ScreeningSummary() {
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
      ? 'this project\'s decisions'
      : currentReviewer === 'consolidation'
        ? 'the consolidated result'
        : currentReviewer
          ? `Reviewer ${currentReviewer}'s own decisions`
          : 'no reviewer (pick one above)'

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div
        className="modal screening-summary"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <strong>Screening summary</strong>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="screening-summary-seat">Counting {seatLabel}.</p>
          <div className="screening-summary-headline">
            <div>
              <strong>{counts.total}</strong>
              <span>total</span>
            </div>
            <div>
              <strong>{counts.included}</strong>
              <span>included</span>
            </div>
            <div>
              <strong>{counts.excluded}</strong>
              <span>excluded</span>
            </div>
            <div>
              <strong>{counts.undecided}</strong>
              <span>undecided</span>
            </div>
          </div>
          <table className="screening-summary-table">
            <thead>
              <tr>
                <th>Exclusion reason</th>
                <th>Papers</th>
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
                  <td>No reason recorded / not one of the configured reasons</td>
                  <td>{counts.excludedWithoutReason}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
