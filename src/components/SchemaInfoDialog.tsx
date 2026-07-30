import { useEffect } from 'react'
import { useStore } from '../state/store'
import { linkifyText } from '../model/linkify'

/**
 * The schema-wide comment authored via `Project.schemaInfo`. Auto-opened once
 * per project load by `loadFromText` (see `schemaInfoOpen`), and reopenable
 * from the annotation panel's ⓘ button. Closed by the × button, the "Okay"
 * button, an outside click, or Escape — the same set `HelpDialog` offers.
 *
 * Rendered above every other overlay (`.schema-info-overlay`'s z-index),
 * per the explicit request that it not be blocked by anything else.
 */
export function SchemaInfoDialog() {
  const open = useStore((s) => s.schemaInfoOpen)
  const setOpen = useStore((s) => s.setSchemaInfoOpen)
  const text = useStore((s) => s.project?.schemaInfo ?? null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open || !text) return null

  return (
    <div className="modal-overlay schema-info-overlay" onClick={() => setOpen(false)}>
      <div
        className="modal schema-info-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="About this schema"
      >
        <div className="modal-head">
          <strong>About this schema</strong>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="schema-info-text">
            {linkifyText(text).map((seg, i) =>
              seg.href ? (
                <a key={i} href={seg.href} target="_blank" rel="noreferrer">
                  {seg.text}
                </a>
              ) : (
                seg.text
              ),
            )}
          </p>
        </div>
        <div className="schema-info-actions">
          <button type="button" className="primary" onClick={() => setOpen(false)}>
            Okay
          </button>
        </div>
      </div>
    </div>
  )
}
