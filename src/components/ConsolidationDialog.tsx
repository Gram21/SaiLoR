import { useEffect } from 'react'
import { useStore, selectCurrentPaper, fieldPath, peekValue } from '../state/store'
import { resolvePath, displayPath } from '../llm/paths'
import { emptyValue, type FieldValue } from '../model/annotations'
import { isEmptyValue } from '../model/validate'
import { comparable } from '../consolidate/unanimous'
import type { ResolvedDef } from '../model/schema'

/**
 * Only reachable from Consolidation mode's "compare" button on a field (see
 * `Field.tsx`). Shows every reviewer's answer for that one field, side by
 * side, so the final call is informed rather than a guess. Picking a row
 * writes through the ordinary `setFieldValue` — Consolidation *is* the active
 * reviewer while this is open, so that write already lands in the
 * consolidated tree via `currentTree`'s routing; nothing dialog-specific is
 * needed on the store side beyond opening/closing. Closing without picking
 * changes nothing.
 *
 * Follows the app's modal pattern (`.modal-overlay` → `.modal` → `.modal-head`
 * + `.modal-body`, Escape-to-close, backdrop click) — see `ValidationDialog.tsx`.
 */
export function ConsolidationDialog() {
  const target = useStore((s) => s.consolidationTarget)
  const closeConsolidation = useStore((s) => s.closeConsolidation)
  const project = useStore((s) => s.project)
  const paper = useStore(selectCurrentPaper)
  const setFieldValue = useStore((s) => s.setFieldValue)
  const toggleFieldEquality = useStore((s) => s.toggleFieldEquality)

  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeConsolidation()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [target, closeConsolidation])

  if (!target || !project || !paper) return null

  // Re-resolve against the live schema (not just trust what opened the
  // popup) — the schema could in principle have changed underneath it.
  const canonical = fieldPath(target.path, target.name, target.index)
  const resolved = resolvePath(project.schema, canonical)
  if (!resolved) return null
  const def = resolved.def
  const label = displayPath([...target.path, { name: target.name, index: target.index }])

  const reviewerIds = Array.from({ length: project.reviewers }, (_, i) => String(i + 1))
  const rows = reviewerIds.map((reviewer) => ({
    reviewer,
    value: peekValue(paper.reviews[reviewer] ?? {}, target.path, target.name, target.index),
  }))
  const consolidatedValue = peekValue(paper.annotations, target.path, target.name, target.index)

  const answered = rows
    .map((r) => r.value)
    .filter((v) => !isEmptyValue(def.type, v ?? emptyValue(def.type)))
  const distinct = new Set(answered.map((v) => JSON.stringify(v)))
  const markedEqual = paper.equal.includes(canonical)
  // A field the consolidator has declared equivalent reads as agreement no
  // matter what the raw text says — that declaration *is* the reconciliation.
  const agreement: 'agree' | 'disagree' | null =
    answered.length === 0 ? null : distinct.size === 1 || markedEqual ? 'agree' : 'disagree'

  // The checkbox only makes sense when there is something to declare: at
  // least two reviewers answered, and their answers still differ once case
  // and whitespace are normalised away (the same rule unanimous adoption
  // uses). Below that bar there is nothing for "mean the same thing" to add —
  // either there's no second opinion, or the values already read as one
  // answer — so the box is hidden rather than offered as a no-op.
  const comparableAnswers = new Set(answered.map((v) => comparable(v)))
  const canDeclareEqual = answered.length >= 2 && comparableAnswers.size > 1

  const take = (value: FieldValue | undefined) => {
    setFieldValue(target.path, target.name, target.index, value === undefined ? emptyValue(def.type) : value)
    closeConsolidation()
  }

  return (
    <div className="modal-overlay" onClick={closeConsolidation}>
      <div
        className="modal consolidation-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <strong>
            Compare answers <span className="consolidation-field-path">{label}</span>
            {agreement && (
              <span className={`help-mode ${agreement === 'agree' ? 'ok' : 'bad'}`}>
                {agreement === 'agree' ? 'Reviewers agree' : 'Reviewers disagree'}
              </span>
            )}
          </strong>
          <button type="button" className="icon-btn" onClick={closeConsolidation} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="consolidation-current">
            Current consolidated value:{' '}
            <strong>{formatValue(def, consolidatedValue)}</strong>
          </p>
          <ul className="consolidation-rows">
            {rows.map((r) => {
              const isCurrent =
                !isEmptyValue(def.type, r.value ?? emptyValue(def.type)) &&
                JSON.stringify(r.value ?? emptyValue(def.type)) ===
                  JSON.stringify(consolidatedValue ?? emptyValue(def.type))
              return (
                <li key={r.reviewer}>
                  <button
                    type="button"
                    className={`consolidation-row${isCurrent ? ' is-current' : ''}`}
                    onClick={() => take(r.value)}
                    title={`Take Reviewer ${r.reviewer}'s answer into the consolidated result`}
                  >
                    <span className="consolidation-reviewer">Reviewer {r.reviewer}</span>
                    <span className="consolidation-value">{formatValue(def, r.value)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {canDeclareEqual && (
            <label className="consolidation-equal">
              <input
                type="checkbox"
                checked={markedEqual}
                onChange={() => toggleFieldEquality(paper.id, canonical)}
              />
              These answers mean the same thing
            </label>
          )}
        </div>
      </div>
    </div>
  )
}

/** Human-readable rendering of one reviewer's raw value, type-aware. */
function formatValue(def: ResolvedDef, value: FieldValue | undefined): string {
  if (value === undefined || value === null) return '— left empty —'
  if (def.type === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' && value.trim() === '') return '— left empty —'
  return String(value)
}
