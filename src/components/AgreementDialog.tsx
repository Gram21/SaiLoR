import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { agreementInput, type AgreementInput, type FieldAgreement } from '../consolidate/agreement'
import { needsAlignmentCount } from '../consolidate/readiness'
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

export interface MetricSpec {
  key: string
  label: string
  applicable: (input: MetricInput) => Applicability
  compute: (input: MetricInput) => MetricResult
}

/** Order matches the tolerance-for-missing-ratings ladder `metrics.ts` describes:
 *  strictest (exactly two, fully paired) first, most forgiving of gaps last. */
export const METRICS: MetricSpec[] = [
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
 * The per-field table as tab-separated text, for the "Copy" button — pulled
 * out as a pure function so the exact cell wording is testable without
 * mounting the dialog. `metrics` is whichever of `METRICS` the reviewer has
 * ticked, in that order, matching the columns actually shown on screen.
 */
export function perFieldTsv(perField: FieldAgreement[], metrics: MetricSpec[]): string {
  const header = ['Field', 'N', ...metrics.map((m) => m.label)]
  const rows = perField.map((f) => {
    const cells = metrics.map((m) => {
      const applicability = m.applicable(f.input)
      if (!applicability.usable) return ''
      const result = m.compute(f.input)
      return result.value !== null ? result.value.toFixed(3) : ''
    })
    return [f.label, String(f.unitCount), ...cells]
  })
  return [header, ...rows].map((r) => r.join('\t')).join('\n')
}

/**
 * Copy to the clipboard, tolerating environments where the async Clipboard
 * API is unavailable or denied (no secure context, no permission granted) —
 * the legacy `execCommand('copy')` route still works in those, run against a
 * throwaway off-screen textarea. Resolves `false` rather than throwing when
 * both routes fail, so the caller can simply skip the "Copied" confirmation
 * instead of surfacing an error for what is a convenience button.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fall through to the legacy route below.
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

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
  const adoptAllUnanimousAnnotations = useStore((s) => s.adoptAllUnanimousAnnotations)
  const unanimousRun = useStore((s) => s.unanimousRun)

  // Gated on `open`, not just `project`: this component is mounted for the
  // whole session (App.tsx renders it unconditionally and it returns null when
  // closed), so an ungated memo recomputes on *every* project change — i.e.
  // every annotation keystroke. Real work on a large project (`agreementInput`
  // walks every paper; `needsAlignmentCount` re-checks every alignable node),
  // so paying it while the dialog is shut would stall typing. Opening the
  // dialog is an explicit, occasional action; that is when it runs.
  const built: AgreementInput | null = useMemo(
    () => (open && project ? agreementInput(project) : null),
    [open, project],
  )
  // See `needsAlignment` in readiness.ts: a paper whose repeatable entries
  // (Findings, say) two or more reviewers recorded but nobody has lined up
  // yet makes the coefficients below unreliable — not absent, just wrong in
  // a way that looks like data.
  const needsAlignment = useMemo(
    () => (open && project ? needsAlignmentCount(project.schema, project.papers, project.reviewers) : 0),
    [open, project],
  )

  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [copied, setCopied] = useState(false)

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
          {needsAlignment > 0 && (
            <div className="agreement-alignment-warning" role="alert">
              <p>
                <strong>{needsAlignment}</strong> paper{needsAlignment === 1 ? '' : 's'}{' '}
                {needsAlignment === 1 ? 'has' : 'have'} repeated entries (like <em>Findings</em>) that two or
                more reviewers recorded, and Consolidation hasn&apos;t reviewed yet. Until it has, the
                numbers below can read as near-total disagreement between reviewers who actually agreed,
                just in a different order — running the button lines the entries up and fills in any
                unanimous answers, but a real disagreement still needs Consolidation to look at it, the
                same as any other unreviewed field.
              </p>
              <button
                type="button"
                disabled={unanimousRun?.running}
                title="Lines every paper's reviewer entries up and adopts any answer every reviewer agrees on — the same action as the Adopt all unanimous button in the annotation panel"
                onClick={() => void adoptAllUnanimousAnnotations()}
              >
                {unanimousRun?.running
                  ? `Lining up… ${unanimousRun.done}/${unanimousRun.total}`
                  : 'Line them up now'}
              </button>
            </div>
          )}
          {built.unitCount === 0 ? (
            // Two different "nothing to measure" cases, and saying the wrong one
            // is worse than saying nothing: telling a reviewer their team has
            // answered nothing, when in fact every answered field was a yes/no
            // that cannot be measured, contradicts work they can see on screen.
            built.booleansExcluded > 0 ? (
              <p>
                The only fields two or more reviewers have both answered are yes/no fields, and
                those cannot be measured. An unticked box reads the same whether the reviewer
                considered it and said no or never looked at it, so there is no way to tell an
                agreement from an absence — counting them would report more agreement than the
                data supports. Agreement can be measured once a text, number, year or
                multiple-choice field has been answered by at least two reviewers.
              </p>
            ) : (
              <p>
                No annotation field has been answered by two or more reviewers anywhere in this
                project yet, so there is nothing to measure agreement over.
              </p>
            )
          ) : (
            <>
              <p className="agreement-basis">
                Computed over <strong>{built.unitCount}</strong> field
                {built.unitCount === 1 ? '' : 's'} — one annotation field on one paper counts as
                one — each answered by at least two reviewers.{' '}
                {built.skipped > 0 &&
                  `${built.skipped} more ${built.skipped === 1 ? 'was' : 'were'} skipped for having fewer than two answers.`}
              </p>
              {built.booleansExcluded > 0 && (
                <p className="agreement-basis">
                  <strong>{built.booleansExcluded}</strong> yes/no field
                  {built.booleansExcluded === 1 ? ' was' : 's were'} left out. An unticked box reads
                  the same whether the reviewer considered it and said no or never looked at it, so
                  there is no way to tell an agreement from an absence — counting them would report
                  more agreement than the data supports.
                </p>
              )}
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
              {built.perField.length > 1 && (
                <PerFieldTable
                  perField={built.perField}
                  metrics={METRICS.filter((m) => selected.has(m.key))}
                  copied={copied}
                  onCopy={() => {
                    const tsv = perFieldTsv(
                      built.perField,
                      METRICS.filter((m) => selected.has(m.key)),
                    )
                    void copyText(tsv).then((ok) => {
                      if (!ok) return
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    })
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Breaks the pooled coefficient(s) above out per schema field — a `Year` and
 * a free-text `Claim` were never in the same category space, and one number
 * over both hides that (see `agreement.ts`'s `FieldAgreement`). Scrolls
 * horizontally rather than squeezing columns: a schema with several metrics
 * ticked and many fields is wider than the dialog, and a squeezed number is
 * worse than a scrollbar.
 */
function PerFieldTable({
  perField,
  metrics,
  copied,
  onCopy,
}: {
  perField: FieldAgreement[]
  metrics: MetricSpec[]
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="agreement-perfield">
      <div className="agreement-perfield-head">
        <h3 className="agreement-perfield-title">Per field</h3>
        <button type="button" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy as TSV'}
        </button>
      </div>
      <div className="agreement-perfield-scroll">
        <table className="agreement-perfield-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>N</th>
              {metrics.map((m) => (
                <th key={m.key}>{m.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {perField.map((f) => (
              <tr key={f.key}>
                <td>{f.label}</td>
                <td>{f.unitCount}</td>
                {metrics.map((m) => {
                  const applicability = m.applicable(f.input)
                  if (!applicability.usable) {
                    return (
                      <td key={m.key} className="agreement-perfield-na" title={applicability.reason}>
                        —
                      </td>
                    )
                  }
                  const result = m.compute(f.input)
                  return (
                    <td key={m.key} title={result.note}>
                      {result.value !== null ? result.value.toFixed(3) : '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
