// [impl->req~con-440~1]
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { copyText } from '../clipboard'
import { rich, tp, useT } from '../i18n'
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
import { Modal } from './Modal'

export interface MetricSpec {
  key: string
  label: string
  applicable: (input: MetricInput) => Applicability
  compute: (input: MetricInput) => MetricResult
}

// [impl->req~con-310~1]
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

// [impl->req~con-310~1]
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
 * Consolidation's "how much do the reviewers actually agree" dialog. Picks
 * up where `DisagreementOverview` leaves off: that one points at individual
 * fields to fix, this one answers the question in aggregate, over whichever
 * of the three coefficients in `metrics.ts` the reviewer wants to see.
 *
 * Follows the app's modal pattern (`.modal-overlay` → `.modal` → `.modal-head`
 * + `.modal-body`, Escape-to-close, backdrop click) — see `ValidationDialog.tsx`.
 */
export function AgreementDialog() {
  const t = useT()
  const open = useStore((s) => s.agreementOpen)
  const closeAgreement = useStore((s) => s.closeAgreement)
  const project = useStore((s) => s.project)
  const adoptAllUnanimousAnnotations = useStore((s) => s.adoptAllUnanimousAnnotations)
  const readOnly = useStore((s) => s.readOnly)
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
  // [impl->req~con-330~1]
  const needsAlignment = useMemo(
    () => (open && project ? needsAlignmentCount(project.schema, project.papers, project.reviewers) : 0),
    [open, project],
  )

  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [copied, setCopied] = useState(false)
  const [copiedEntry, setCopiedEntry] = useState(false)

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
      if (e.key === 'Escape') closeAgreement()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, closeAgreement])

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
    <Modal onClose={closeAgreement} className="agreement-dialog">
      <div className="modal-head">
        <strong>{t('consolidation.agreement.title')}</strong>
        <button type="button" className="icon-btn" onClick={closeAgreement} aria-label={t('common.close')} title={t('common.close')}>
          ×
        </button>
      </div>
      <div className="modal-body">
        {needsAlignment > 0 && (
          <div className="agreement-alignment-warning" role="alert">
            <p>
              {rich('consolidation.agreement.alignWarning', {
                count: needsAlignment,
                lead: tp('consolidation.agreement.alignLead', needsAlignment),
              })}
            </p>
            <button
              type="button"
              disabled={unanimousRun?.running || readOnly}
              title={t('consolidation.agreement.alignTitle')}
              onClick={() => void adoptAllUnanimousAnnotations()}
            >
              {unanimousRun?.running
                ? t('consolidation.agreement.liningUp', { done: unanimousRun.done, total: unanimousRun.total })
                : t('consolidation.agreement.lineUp')}
            </button>
          </div>
        )}
        {built.unitCount === 0 ? (
          <p>{t('consolidation.agreement.noneAnswered')}</p>
        ) : (
          <>
            <p className="agreement-basis">
              {rich('consolidation.agreement.basis', {
                count: built.unitCount,
                noun: tp('consolidation.agreement.fieldNoun', built.unitCount),
              })}{' '}
              {built.skipped > 0 && tp('consolidation.agreement.skipped', built.skipped)}
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
            {built.perField.length > 1 && (
              <PerFieldTable
                perField={built.perField}
                title={t('consolidation.agreement.perField')}
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
            {built.perEntry.length > 0 && (
              <PerFieldTable
                title={t('consolidation.agreement.perEntry')}
                perField={built.perEntry}
                metrics={METRICS.filter((m) => selected.has(m.key))}
                copied={copiedEntry}
                onCopy={() => {
                  const tsv = perFieldTsv(
                    built.perEntry,
                    METRICS.filter((m) => selected.has(m.key)),
                  )
                  void copyText(tsv).then((ok) => {
                    if (!ok) return
                    setCopiedEntry(true)
                    setTimeout(() => setCopiedEntry(false), 2000)
                  })
                }}
              />
            )}
          </>
        )}
      </div>
      
    </Modal>
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
  title,
  perField,
  metrics,
  copied,
  onCopy,
}: {
  title: string
  perField: FieldAgreement[]
  metrics: MetricSpec[]
  copied: boolean
  onCopy: () => void
}) {
  const t = useT()
  return (
    <div className="agreement-perfield">
      <div className="agreement-perfield-head">
        <h3 className="agreement-perfield-title">{title}</h3>
        <button
          type="button"
          onClick={onCopy}
          title={t('consolidation.agreement.copyTitle', { table: title.toLowerCase().replace(' ', '-') })}
        >
          {copied ? t('consolidation.agreement.copied') : t('consolidation.agreement.copyTsv')}
        </button>
      </div>
      <div className="agreement-perfield-scroll">
        <table className="agreement-perfield-table">
          <thead>
            <tr>
              <th>{t('consolidation.agreement.field')}</th>
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
