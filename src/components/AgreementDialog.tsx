import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { agreementInput, type AgreementInput } from '../consolidate/agreement'
import {
  cohenKappa,
  cohenKappaApplicable,
  fleissKappa,
  fleissKappaApplicable,
  krippendorffAlpha,
  krippendorffAlphaApplicable,
  type Applicability,
  type MetricInput,
  type MetricResult,
} from '../consolidate/metrics'

interface MetricSpec {
  key: string
  label: string
  applicable: (input: MetricInput) => Applicability
  compute: (input: MetricInput) => MetricResult
}

/** Order matches the tolerance-for-missing-ratings ladder `metrics.ts` describes:
 *  strictest (exactly two, fully paired) first, most forgiving of gaps last. */
const METRICS: MetricSpec[] = [
  { key: 'cohen', label: "Cohen's κ", applicable: cohenKappaApplicable, compute: cohenKappa },
  { key: 'fleiss', label: "Fleiss' κ", applicable: fleissKappaApplicable, compute: fleissKappa },
  {
    key: 'krippendorff',
    label: "Krippendorff's α",
    applicable: krippendorffAlphaApplicable,
    compute: krippendorffAlpha,
  },
]

/**
 * Consolidation's "how much do the reviewers actually agree" dialog. Picks
 * up where `DisagreementOverview` leaves off: that one points at individual
 * fields to fix, this one answers the question in aggregate, over whichever
 * of the three coefficients in `metrics.ts` the reviewer wants to see.
 *
 * Follows the app's modal pattern (`.modal-overlay` → `.modal` → `.modal-head`
 * + `.modal-body`, Escape-to-close, backdrop click) — see `ValidationDialog.tsx`.
 */
export function AgreementDialog() {
  const open = useStore((s) => s.agreementOpen)
  const setOpen = useStore((s) => s.setAgreementOpen)
  const project = useStore((s) => s.project)

  const built: AgreementInput | null = useMemo(() => (project ? agreementInput(project) : null), [project])

  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  // Default to whichever metrics this project's data can actually support,
  // rather than nothing: a reviewer opening this dialog came to see agreement,
  // not to first learn which of three unfamiliar statistics applies to their
  // project. Re-derived only when the dialog opens (or the underlying data
  // changes) — ticking a box by hand is never silently undone by this effect.
  useEffect(() => {
    if (!open || !built) return
    const usable = new Set(METRICS.filter((m) => m.applicable(built.input).usable).map((m) => m.key))
    setSelected(usable)
  }, [open, built])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open || !project || !built) return null

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div
        className="modal agreement-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <strong>Inter-rater agreement</strong>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {built.unitCount === 0 ? (
            <p>
              No annotation field has been answered by two or more reviewers anywhere in this
              project yet, so there is nothing to measure agreement over.
            </p>
          ) : (
            <>
              <p className="agreement-basis">
                Computed over <strong>{built.unitCount}</strong> field
                {built.unitCount === 1 ? '' : 's'} — one annotation field on one paper counts as
                one — each answered by at least two reviewers.{' '}
                {built.skipped > 0 &&
                  `${built.skipped} more ${built.skipped === 1 ? 'was' : 'were'} skipped for having fewer than two answers.`}
              </p>
              <ul className="agreement-metrics">
                {METRICS.map((m) => {
                  const applicability = m.applicable(built.input)
                  const checked = selected.has(m.key)
                  const result = checked ? m.compute(built.input) : null
                  return (
                    <li
                      key={m.key}
                      className={`agreement-metric${applicability.usable ? '' : ' unusable'}`}
                      title={applicability.usable ? undefined : applicability.reason}
                    >
                      <label className="agreement-metric-label">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!applicability.usable}
                          onChange={() => toggle(m.key)}
                        />
                        {m.label}
                      </label>
                      {result && (
                        <span className="agreement-result">
                          {result.value !== null && (
                            <strong className="agreement-value">{result.value.toFixed(3)}</strong>
                          )}
                          {result.note && <span className="agreement-note">{result.note}</span>}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
