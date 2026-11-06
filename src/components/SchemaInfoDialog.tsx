// [impl->req~edt-80~1]
import { useEffect } from 'react'
import { useStore } from '../state/store'
import { linkifyText } from '../model/linkify'
import { useT } from '../i18n'
import { Modal } from './Modal'

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
  const t = useT()

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
    <Modal overlayClassName="schema-info-overlay" onClose={() => setOpen(false)} className="schema-info-dialog" aria-label={t('app.schemaInfo.title')}>
      <div className="modal-head">
        <strong>{t('app.schemaInfo.title')}</strong>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setOpen(false)}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
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
        <button type="button" className="primary" onClick={() => setOpen(false)} title={t('app.schemaInfo.closeTitle')}>
          {t('app.schemaInfo.ok')}
        </button>
      </div>
      
    </Modal>
  )
}
