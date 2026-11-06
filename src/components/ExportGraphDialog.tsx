// [impl->req~dat-520~1]
import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { getPlatform } from '../platform'
import { seatLabel } from '../model/project'
import { buildGraph, graphSource, graphTrees, toCsvEdges, toCsvNodes, toGraphMl, toJsonLd, toTurtle } from '../model/graph'
import { useT } from '../i18n'
import '../styles/ai.css'
import { Modal } from './Modal'

type Format = 'jsonld' | 'ttl' | 'graphml' | 'csv'

const FORMATS: Format[] = ['jsonld', 'ttl', 'graphml', 'csv']

export function ExportGraphDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)
  const t = useT()
  const [format, setFormat] = useState<Format>('jsonld')
  const [seat, setSeat] = useState('1')
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState<{ ok: boolean; text: string }[]>([])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!project) return null
  const source = graphSource(project)
  const seats = Array.from({ length: project.reviewers }, (_, i) => String(i + 1))

  const runExport = async () => {
    setBusy(true)
    setMessages([])
    const graph = buildGraph(project, graphTrees(project, seat))
    const files: [string, string][] =
      format === 'csv'
        ? [
            ['knowledge-graph-nodes.csv', toCsvNodes(graph)],
            ['knowledge-graph-edges.csv', toCsvEdges(graph)],
          ]
        : [[`knowledge-graph.${format}`, { jsonld: toJsonLd, ttl: toTurtle, graphml: toGraphMl }[format](graph)]]
    const platform = getPlatform()
    const done: { ok: boolean; text: string }[] = []
    try {
      for (const [name, text] of files) {
        const path = await platform.pickTextExportPath(name, format)
        if (!path) break
        const res = await platform.writeTextFile(path, text)
        done.push(
          res.ok
            ? { ok: true, text: t('app.export.saved', { path: res.path }) }
            : { ok: false, text: t('app.export.saveFailed', { error: res.error }) },
        )
        if (!res.ok) break
      }
    } catch (err) {
      done.push({ ok: false, text: t('app.export.saveFailed', { error: String(err) }) })
    } finally {
      setMessages(done)
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} aria-label={t('exportGraph.title')}>
      <div className="modal-head">
        <strong>{t('exportGraph.title')}</strong>
        <button type="button" className="icon-btn" title={t('common.close')} onClick={onClose} aria-label={t('common.close')}>
          ×
        </button>
      </div>
      <div className="modal-body">
        <fieldset>
          <legend>{t('exportGraph.format')}</legend>
          {FORMATS.map((f) => (
            <label key={f}>
              <input
                type="radio"
                name="export-graph-format"
                checked={format === f}
                onChange={() => setFormat(f)}
                disabled={busy}
              />
              <span>{t(`exportGraph.${f}` as const)}</span>
            </label>
          ))}
        </fieldset>
        {format === 'csv' && <p>{t('exportGraph.csvHint')}</p>}
        {project.reviewers > 1 && source === 'consolidated' && <p>{t('exportGraph.consolidated')}</p>}
        {source === 'seat' && (
          <>
            <p>{t('exportGraph.pickSeat')}</p>
            <label>
              <span>{t('exportGraph.seat')} </span>
              <select value={seat} onChange={(e) => setSeat(e.target.value)} disabled={busy}>
                {seats.map((s) => (
                  <option key={s} value={s}>
                    {seatLabel(project, s)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {messages.map((m, i) => (
          <p key={i} className={m.ok ? undefined : 'ai-error'}>
            {m.text}
          </p>
        ))}
        <div className="screening-import-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            {t('common.close')}
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void runExport()}>
            {busy ? t('exportGraph.exporting') : t('exportGraph.export')}
          </button>
        </div>
      </div>
      
    </Modal>
  )
}
