import { useEffect, useState } from 'react'
import { useStore, selectCurrentPaper, fieldPath, peekValue } from '../state/store'
import { resolvePath, displayPath } from '../llm/paths'
import { emptyValue, type FieldValue } from '../model/annotations'
import { alignedReviews } from '../model/alignment'
import { isEmptyValue } from '../model/validate'
import { comparable } from '../consolidate/unanimous'
import { SCREENING_DECISION } from '../screening/schema'
import type { ResolvedDef } from '../model/schema'

/**
 * Whether leaving now would strand the field: declared equivalent, but with no
 * value recorded.
 *
 * That combination is the worst of both worlds and has to be caught. The mark
 * settles *that* the reviewers agreed, which is enough to drop the field out of
 * the disagreement list and count it as agreement in the statistics — but it
 * says nothing about *what* they agreed on, so the consolidated result stays
 * blank. The field then reads as resolved everywhere while holding no answer,
 * and nothing will ever surface it again.
 *
 * Emptiness is `isEmptyValue`, the same rule this dialog uses everywhere else,
 * which means a boolean never counts as stranded — an unticked box is a real
 * `false` in the data, not a gap, and there is no third state to record.
 */
export function closingWouldStrand(
  def: ResolvedDef,
  markedEqual: boolean,
  consolidatedValue: FieldValue | undefined,
): boolean {
  return markedEqual && isEmptyValue(def.type, consolidatedValue ?? emptyValue(def.type))
}

/**
 * The compare popup's agreement verdict. Decided in `comparable()` form, not
 * raw equality, because `disagreements.ts` (the status dot, the disagreement
 * list, every coefficient) and `unanimous.ts` (auto-adoption) both do — and
 * unanimous.ts's own comment names this popup as the third consumer that must
 * reach the same verdict. A consolidator's equivalence mark overrides, same as
 * `MARKED_EQUAL_CATEGORY` in disagreements.ts.
 */
export function agreementVerdict(
  answered: Array<FieldValue | undefined>,
  markedEqual: boolean,
): 'agree' | 'disagree' | null {
  if (answered.length === 0) return null
  return markedEqual || new Set(answered.map(comparable)).size === 1 ? 'agree' : 'disagree'
}

/**
 * Only reachable from Consolidation mode's "compare" button on a field (see
 * `Field.tsx`). Shows every reviewer's answer for that one field, side by
 * side, so the final call is informed rather than a guess. Picking a row
 * writes through the ordinary `setFieldValue` — Consolidation *is* the active
 * reviewer while this is open, so that write already lands in the
 * consolidated tree via `currentTree`'s routing; nothing dialog-specific is
 * needed on the store side beyond opening/closing.
 *
 * Closing without picking changes nothing — *unless* the answers have been
 * declared equivalent, in which case see `closingWouldStrand`.
 *
 * Follows the app's modal pattern (`.modal-overlay` → `.modal` → `.modal-head`
 * + `.modal-body`, Escape-to-close, backdrop click) — see `ValidationDialog.tsx`.
 */
export function ConsolidationDialog() {
  const target = useStore((s) => s.consolidationTarget)
  const closeConsolidation = useStore((s) => s.closeConsolidation)
  const project = useStore((s) => s.project)
  const paper = useStore(selectCurrentPaper)
  const resolveConsolidationValue = useStore((s) => s.resolveConsolidationValue)
  const deferConsolidationValue = useStore((s) => s.deferConsolidationValue)
  const toggleFieldEquality = useStore((s) => s.toggleFieldEquality)

  // Raised when leaving would strand the field, rather than letting it go and
  // hoping the reviewer noticed. Local, not store state: it belongs to this
  // dialog's lifetime and means nothing once it closes.
  const [confirmingClose, setConfirmingClose] = useState(false)

  // Re-resolve against the live schema (not just trust what opened the popup) —
  // the schema could in principle have changed underneath it. Derived up here,
  // null-tolerantly, because the Escape handler below needs the same verdict and
  // hooks cannot live past the early return.
  const canonical = target ? fieldPath(target.path, target.name, target.index) : null
  const resolved = project && canonical ? resolvePath(project.schema, canonical) : null
  const def = resolved?.def ?? null
  const markedEqual = !!(paper && canonical && paper.equal.includes(canonical))
  const consolidatedValue =
    paper && target ? peekValue(paper.annotations, target.path, target.name, target.index) : undefined
  const stranded = def ? closingWouldStrand(def, markedEqual, consolidatedValue) : false

  // A fresh field starts with no question hanging over it.
  useEffect(() => {
    setConfirmingClose(false)
  }, [target])

  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Escape backs out of the warning rather than through it: discarding the
      // mark is destructive, so it should take a deliberate click, not the key
      // people hit to dismiss things.
      if (confirmingClose) setConfirmingClose(false)
      else if (stranded) setConfirmingClose(true)
      else closeConsolidation()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [target, confirmingClose, stranded, closeConsolidation])

  if (!target || !project || !paper || !def || !canonical) return null

  const label = displayPath([...target.path, { name: target.name, index: target.index }])

  const reviewerIds = Array.from({ length: project.reviewers }, (_, i) => String(i + 1))
  // `target.index` is a consolidated-tree index, i.e. a slot. Reading each
  // reviewer's own array at that number would only line up if their entries had
  // been permuted into slot order, which consolidation no longer does — so the
  // rows come from the lined-up view instead (see `model/alignment.ts`).
  const lined = alignedReviews(
    project.schema,
    paper.alignment,
    Object.fromEntries(reviewerIds.map((r) => [r, paper.reviews[r]])),
  )
  const rows = reviewerIds.map((reviewer) => ({
    reviewer,
    value: peekValue(lined[reviewer] ?? {}, target.path, target.name, target.index),
  }))

  const answered = rows
    .map((r) => r.value)
    .filter((v) => !isEmptyValue(def.type, v ?? emptyValue(def.type)))
  const agreement = agreementVerdict(answered, markedEqual)

  // The checkbox only makes sense when there is something to declare: at
  // least two reviewers answered, and their answers still differ once case
  // and whitespace are normalised away (the same rule unanimous adoption
  // uses). Below that bar there is nothing for "mean the same thing" to add —
  // either there's no second opinion, or the values already read as one
  // answer — so the box is hidden rather than offered as a no-op.
  const comparableAnswers = new Set(answered.map((v) => comparable(v)))
  // "Include and Exclude mean the same thing" is not a claim anyone can make.
  // Without this guard a consolidator could mark two opposite screening
  // decisions equivalent, dropping a real disagreement out of the overview
  // while inflating agreement. The box stays available on the Reason field,
  // where two overlapping reasons genuinely can be equivalent.
  const isScreeningDecision =
    project.screening !== null && target.path.length === 0 && target.name === SCREENING_DECISION
  const canDeclareEqual = answered.length >= 2 && comparableAnswers.size > 1 && !isScreeningDecision

  const requestClose = () => {
    if (stranded) setConfirmingClose(true)
    else closeConsolidation()
  }

  const take = (value: FieldValue | undefined) => {
    const taken = value === undefined ? emptyValue(def.type) : value
    if (isEmptyValue(def.type, taken)) {
      deferConsolidationValue(target.path, target.name, target.index)
    } else {
      resolveConsolidationValue(target.path, target.name, target.index, taken)
    }
    closeConsolidation()
  }

  const defer = () => {
    deferConsolidationValue(target.path, target.name, target.index)
    closeConsolidation()
  }

  /** Leave, and undo the claim the reviewer declined to back with a value. */
  const discardAndClose = () => {
    if (markedEqual) toggleFieldEquality(paper.id, canonical)
    setConfirmingClose(false)
    closeConsolidation()
  }

  return (
    <div className="modal-overlay" onClick={requestClose}>
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
          <button type="button" className="icon-btn" onClick={requestClose} aria-label="Close">
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
          <button type="button" className="consolidation-defer" onClick={defer}>
            Enter a different value
          </button>
          {canDeclareEqual && (
            <>
              <label className="consolidation-equal">
                <input
                  type="checkbox"
                  checked={markedEqual}
                  onChange={() => toggleFieldEquality(paper.id, canonical)}
                />
                These answers mean the same thing
              </label>
              {/* The distinction the whole feature turns on, and the one people
                  get wrong: the tick settles *that* the reviewers agreed, not
                  *what* they agreed on. Said plainly and up front, because the
                  alternative is finding out via the warning below. */}
              <p className={`consolidation-hint${stranded ? ' needed' : ''}`}>
                {stranded
                  ? 'Now pick the answer above that the consolidated result should record. Marking them equivalent settles that the reviewers agreed; it does not record what they agreed on.'
                  : 'Marking answers equivalent settles that the reviewers agreed. Pick one of them above as well, so the consolidated result records what they agreed on.'}
              </p>
            </>
          )}

          {confirmingClose && (
            <div className="consolidation-warning" role="alert">
              <p>
                <strong>This field would be left with no answer.</strong> You marked the reviewers'
                answers as meaning the same thing, so it no longer counts as a disagreement — but
                nothing has been recorded as the consolidated value, so it will not show up in the
                disagreement list again either.
              </p>
              <div className="consolidation-warning-actions">
                <button type="button" className="primary" onClick={() => setConfirmingClose(false)}>
                  Pick a value
                </button>
                <button type="button" onClick={discardAndClose}>
                  Close and un-mark them
                </button>
              </div>
            </div>
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
