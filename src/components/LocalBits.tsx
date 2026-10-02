import type { ReactNode } from 'react'

/** Small pieces shared by the local-model setup panels. */

export function Unavailable() {
  return <p className="llm-hint llm-wide">Available in the desktop app.</p>
}

/** The explicit-consent step that sits between "show the plan" and "download". */
export function ConsentBox(p: {
  label: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  /** When set, confirming is impossible and this says why. */
  blockedReason?: string
}) {
  return (
    <div role="group" aria-label={p.label} className="llm-consent">
      <p>{p.children}</p>
      {p.blockedReason && (
        <p role="alert" className="llm-status-error">
          {p.blockedReason}
        </p>
      )}
      <div className="llm-consent-actions">
        <button type="button" className="primary" onClick={p.onConfirm} disabled={Boolean(p.blockedReason)} title={p.blockedReason}>
          {p.confirmLabel}
        </button>
        <button type="button" onClick={p.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export function Bar({ label, completed, total }: { label: string; completed: number; total: number }) {
  return (
    <progress aria-label={label} className="llm-progress" value={total > 0 ? completed : undefined} max={total > 0 ? total : undefined} />
  )
}
