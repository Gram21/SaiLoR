import { useEditorStore } from '../state/editorStore'

/**
 * Pre-commit summary shown after picking a screening project via
 * "New from screening…" or "Import from screening…", before anything is
 * written. Follows the `ValidationDialog` modal pattern.
 *
 * Undecided papers are carried by default (dropping them would silently
 * remove papers from a systematic review) — this dialog is what makes that
 * explicit rather than silent, and gives the reviewer the "leave them out"
 * escape hatch.
 */
export function ScreeningImportDialog() {
  const draft = useEditorStore((s) => s.screeningImport)
  const resolveScreeningImport = useEditorStore((s) => s.resolveScreeningImport)
  const busy = useEditorStore((s) => s.busy)

  if (!draft) return null

  const reasonRows = Object.entries(draft.excludedByReason).sort(([, a], [, b]) => b - a)
  const totalScreened = draft.included.length + draft.excludedCount + draft.undecided.length

  return (
    <div className="modal-overlay" onClick={() => resolveScreeningImport('cancel')}>
      <div
        className="modal screening-import-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <strong>Import from {draft.sourceName}</strong>
          <button
            type="button"
            className="icon-btn"
            onClick={() => resolveScreeningImport('cancel')}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="modal-body">
          <p>{totalScreened} papers in this screening project.</p>
          <ul className="screening-import-counts">
            <li>
              <strong>{draft.included.length}</strong> included — always carried over.
            </li>
            <li>
              <strong>{draft.excludedCount}</strong> excluded — never carried over.
              {reasonRows.length > 0 && (
                <ul className="screening-import-reasons">
                  {reasonRows.map(([reason, n]) => (
                    <li key={reason}>
                      {reason}: {n}
                    </li>
                  ))}
                </ul>
              )}
            </li>
            <li>
              <strong>{draft.undecided.length}</strong> not screened yet — carried over by default; you
              can leave them out below.
            </li>
          </ul>
          {draft.multiReviewer && draft.pendingUnanimousCount > 0 && (
            <p className="screening-import-notice">
              {draft.pendingUnanimousCount} of the not-yet-screened papers were decided the same way by
              every reviewer, but Consolidation has not adopted those decisions yet — so this project has
              no final decision for them. Open the screening project as Consolidation and use{' '}
              <strong>Adopt all</strong> first if you want them counted as included.
            </p>
          )}
          <div className="screening-import-actions">
            <button type="button" disabled={busy} onClick={() => resolveScreeningImport('cancel')}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void resolveScreeningImport('skip-undecided')}
            >
              Leave out the {draft.undecided.length} not-screened-yet paper
              {draft.undecided.length === 1 ? '' : 's'}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void resolveScreeningImport('include-undecided')}
            >
              Import {draft.included.length + draft.undecided.length} paper
              {draft.included.length + draft.undecided.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
