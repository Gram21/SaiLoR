// [impl->req~ui-260~1]
import { useRef, useState, type KeyboardEvent } from 'react'
import { useT } from '../i18n'
import type { ImageArea, ImageFormat } from './graphImage'

export type SaveResult = { ok: boolean; text: string } | null

const FORMATS: ImageFormat[] = ['svg', 'png']
const AREAS: ImageArea[] = ['visible', 'all']

/** The download button of the graph area: a panel to pick the image format and area, then save. */
export function GraphDownload({ disabled, onSave }: { disabled: boolean; onSave: (format: ImageFormat, area: ImageArea) => Promise<SaveResult> }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<ImageFormat>('svg')
  const [area, setArea] = useState<ImageArea>('visible')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SaveResult>(null)
  const toggle = useRef<HTMLButtonElement>(null)

  const save = async () => {
    setBusy(true)
    setResult(null)
    try {
      setResult(await onSave(format, area))
    } finally {
      setBusy(false)
    }
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return
    e.stopPropagation()
    setOpen(false)
    toggle.current?.focus()
  }

  return (
    <div className="graph-download" onKeyDown={onKeyDown}>
      <button
        ref={toggle}
        type="button"
        className="graph-download-toggle"
        aria-expanded={open}
        aria-controls="graph-download-panel"
        disabled={disabled}
        title={t('graphView.download.title')}
        onClick={() => setOpen((o) => !o)}
      >
        ⤓ {t('graphView.download')}
      </button>
      {open && (
        <div id="graph-download-panel" className="graph-download-panel" role="group" aria-label={t('graphView.download.title')}>
          <fieldset>
            <legend>{t('graphView.download.format')}</legend>
            {FORMATS.map((f) => (
              <label key={f}>
                <input type="radio" name="graph-image-format" checked={format === f} disabled={busy} onChange={() => setFormat(f)} />
                {t(`graphView.download.${f}` as const)}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>{t('graphView.download.area')}</legend>
            {AREAS.map((a) => (
              <label key={a}>
                <input type="radio" name="graph-image-area" checked={area === a} disabled={busy} onChange={() => setArea(a)} />
                {t(`graphView.download.${a}` as const)}
              </label>
            ))}
          </fieldset>
          <p className="graph-hint">{t('graphView.download.filter')}</p>
          {result && (
            <p className={result.ok ? 'graph-hint' : 'graph-hint graph-error'} role="status">
              {result.text}
            </p>
          )}
          <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
            {busy ? t('exportGraph.exporting') : t('exportGraph.export')}
          </button>
        </div>
      )}
    </div>
  )
}
