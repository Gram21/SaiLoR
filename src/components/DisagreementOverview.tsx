import { useEffect, useMemo } from 'react'
import { useStore } from '../state/store'
import { projectVerdicts, type FieldVerdict } from '../consolidate/disagreements'
import { displayPath } from '../llm/paths'
import type { FieldValue } from '../model/annotations'
import type { ResolvedDef } from '../model/schema'

/** One paper's worth of disagreements, in the order `projectVerdicts` walked them. */
interface PaperGroup {
  paperId: string
  paperTitle: string
  verdicts: FieldVerdict[]
}

/**
 * "Show me every field where reviewers disagree" — the inverse of hunting
 * through each paper by hand. `AgreementDialog` answers *how much* the
 * reviewers agree in aggregate; this answers *where* they don't, and a click
 * takes the consolidator straight there, because finding a disagreement is
 * only useful if it doesn't then have to be re-found by paging through the
 * paper.
 *
 * Follows the app's modal pattern (`.modal-overlay` → `.modal` → `.modal-head`
 * + `.modal-body`, Escape-to-close, backdrop click) — see `ValidationDialog.tsx`.
 */
export function DisagreementOverview() {
  const open = useStore((s) => s.disagreementsOpen)
  const setOpen = useStore((s) => s.setDisagreementsOpen)
  const project = useStore((s) => s.project)
  const selectPaper = useStore((s) => s.selectPaper)
  const openConsolidation = useStore((s) => s.openConsolidation)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  // The two-answers gate that `agreement.ts` gates its statistics on: a field
  // only one reviewer touched is not a disagreement, it's a field nobody has
  // gotten to yet. `verdict.agree` already folds in `markedEqual` (see
  // `disagreements.ts`), so a field the consolidator has declared equivalent
  // drops out here too, without any extra check.
  const groups: PaperGroup[] = useMemo(() => {
    if (!project) return []
    const byPaper = new Map<string, PaperGroup>()
    for (const verdict of projectVerdicts(project)) {
      if (verdict.answeredBy.length < 2 || verdict.agree) continue
      const group = byPaper.get(verdict.paperId) ?? {
        paperId: verdict.paperId,
        paperTitle: verdict.paperTitle,
        verdicts: [],
      }
      group.verdicts.push(verdict)
      byPaper.set(verdict.paperId, group)
    }
    return [...byPaper.values()]
  }, [project])

  if (!open || !project) return null

  const total = groups.reduce((n, g) => n + g.verdicts.length, 0)

  const jumpTo = (v: FieldVerdict) => {
    selectPaper(v.paperId)
    openConsolidation(v.path, v.name, v.index)
    setOpen(false)
  }

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div
        className="modal disagreement-overview"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <strong>
            Disagreements{' '}
            <span className={total === 0 ? 'help-mode ok' : 'help-mode bad'}>
              {total === 0
                ? 'None'
                : `${total} disagreement${total === 1 ? '' : 's'} across ${groups.length} paper${groups.length === 1 ? '' : 's'}`}
            </span>
          </strong>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {total === 0 ? (
            <p>Every field two or more reviewers answered agrees — there is nothing to reconcile here.</p>
          ) : (
            <>
              <p className="disagreement-intro">Click a field to open it for consolidation.</p>
              {groups.map((g) => (
                <section key={g.paperId} className="disagreement-group">
                  <h3 className="disagreement-paper-title">{g.paperTitle}</h3>
                  <ul className="disagreement-rows">
                    {g.verdicts.map((v) => (
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
                </section>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Human-readable rendering of one reviewer's raw value, type-aware — the
 *  same rendering rule `ConsolidationDialog` uses for the same values. */
function formatValue(def: ResolvedDef, value: FieldValue | undefined): string {
  if (value === undefined || value === null) return '— left empty —'
  if (def.type === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' && value.trim() === '') return '— left empty —'
  return String(value)
}
