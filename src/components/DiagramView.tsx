// [impl->req~ui-270~1]
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../state/store'
import { getPlatform } from '../platform'
import { defaultGraphSeat, graphTrees } from '../model/graph'
import {
  BUILTIN_DIMENSIONS,
  CHART_TYPES,
  DEFAULT_CONFIG,
  PALETTES,
  diagramHost,
  schemaDimensions,
  slimProject,
  type DiagramConfig,
  type DiagramReply,
  type DiagramRequest,
  type PaletteName,
} from '../model/diagram'
import { seriesColor } from '../model/diagramSvg'
import { useT } from '../i18n'
import { GraphSeatSelect } from './GraphSeatSelect'
import { svgToPdf, svgToPng, type DiagramFormat } from './diagramExport'

const FORMATS: DiagramFormat[] = ['svg', 'png', 'pdf']
const RENDER_DELAY_MS = 120

type Shown = Extract<DiagramReply, { svg: string }> | { error: string } | null

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="diagram-section">
      <legend>{title}</legend>
      {children}
    </fieldset>
  )
}

/** The diagrams of the answers: settings on the side, a live preview, and export as SVG, PNG or PDF. The data work runs in a worker. */
export function DiagramView({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)
  const t = useT()
  const [seat, setSeat] = useState(() => (project ? defaultGraphSeat(project) : '1'))
  const [config, setConfig] = useState<DiagramConfig>(DEFAULT_CONFIG)
  const [shown, setShown] = useState<Shown>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const post = useRef<(m: DiagramRequest) => void>(() => {})
  const latest = useRef(0)

  const dimensions = useMemo(
    () => [
      ...BUILTIN_DIMENSIONS.map((id) => ({ id: id as string, label: t(`diagram.dim.${id.slice(1) as 'year' | 'venue' | 'author' | 'keyword'}`) })),
      ...(project ? schemaDimensions(project.schema) : []),
    ],
    [project, t],
  )
  const labelOf = (id: string) => dimensions.find((d) => d.id === id)?.label ?? ''
  const effective: DiagramConfig = {
    ...config,
    xLabel: config.xLabel || labelOf(config.x),
    yLabel: config.yLabel || (config.type === 'heatmap' && config.group ? labelOf(config.group) : t('diagram.papers')),
  }
  const effectiveKey = JSON.stringify(effective)

  useEffect(() => {
    const onReply = (r: DiagramReply) => {
      if (r.id === latest.current) setShown('error' in r ? { error: r.error } : r)
    }
    // jsdom has no Worker; there the diagram is made inline with the same code.
    const worker = typeof Worker === 'undefined' ? undefined : new Worker(new URL('../model/diagram.worker.ts', import.meta.url), { type: 'module' })
    if (worker) {
      worker.onmessage = (e: MessageEvent<DiagramReply>) => onReply(e.data)
      worker.onerror = (e) => onReply({ id: latest.current, error: e.message })
    }
    post.current = worker ? (m) => worker.postMessage(m) : diagramHost(onReply)
    return () => worker?.terminate()
  }, [])

  useEffect(() => {
    if (project) post.current({ type: 'data', project: slimProject(project), trees: graphTrees(project, seat) })
  }, [project, seat])

  useEffect(() => {
    const id = ++latest.current
    const timer = setTimeout(() => post.current({ type: 'render', id, config: JSON.parse(effectiveKey) as DiagramConfig }), RENDER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [effectiveKey, project, seat])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!project) return null
  const set = <K extends keyof DiagramConfig>(key: K, value: DiagramConfig[K]) => setConfig((c) => ({ ...c, [key]: value }))
  const ready = shown !== null && 'svg' in shown && shown.papers > 0
  const keys = shown && 'keys' in shown ? shown.keys : []

  // [impl->req~ui-320~1]
  const save = async (format: DiagramFormat) => {
    if (!shown || !('svg' in shown)) return
    setBusy(true)
    setMessage(null)
    try {
      const platform = getPlatform()
      const path = await platform.pickTextExportPath(`diagram.${format}`, format)
      if (!path) return
      const { svg } = shown
      const { width, height } = effective
      const res =
        format === 'svg'
          ? await platform.writeTextFile(path, svg)
          : await platform.writeBinaryFile(path, format === 'png' ? await svgToPng(svg, width, height) : await svgToPdf(svg, width, height))
      setMessage(res.ok ? { ok: true, text: t('app.export.saved', { path: res.path }) } : { ok: false, text: t('app.export.saveFailed', { error: res.error }) })
    } catch (err) {
      setMessage({ ok: false, text: t('app.export.saveFailed', { error: String(err) }) })
    } finally {
      setBusy(false)
    }
  }

  const dimensionSelect = (value: string, onChange: (v: string) => void, none?: string) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {none && <option value="">{none}</option>}
      {dimensions.map((d) => (
        <option key={d.id} value={d.id}>
          {d.label}
        </option>
      ))}
    </select>
  )

  return (
    <div className="result-pane diagram-pane">
      <aside className="diagram-settings" aria-label={t('diagram.settings')}>
        <GraphSeatSelect project={project} value={seat} onChange={setSeat} />
        <Section title={t('diagram.section.data')}>
          <div className="diagram-types" role="radiogroup" aria-label={t('diagram.type')}>
            {CHART_TYPES.map((type) => (
              <button key={type} type="button" role="radio" aria-checked={config.type === type} className={config.type === type ? 'active' : ''} onClick={() => set('type', type)}>
                {t(`diagram.type.${type}` as const)}
              </button>
            ))}
          </div>
          <label>
            {t('diagram.x')}
            {dimensionSelect(config.x, (v) => set('x', v))}
          </label>
          {config.type !== 'pie' && (
            <label>
              {t('diagram.group')}
              {dimensionSelect(config.group, (v) => set('group', v), t('diagram.group.none'))}
            </label>
          )}
          <label>
            {t('diagram.sort')}
            <select value={config.sort} onChange={(e) => set('sort', e.target.value as DiagramConfig['sort'])}>
              <option value="label">{t('diagram.sort.label')}</option>
              <option value="count">{t('diagram.sort.count')}</option>
            </select>
          </label>
          <label>
            {t('diagram.limit')}
            <input type="number" min={2} max={50} value={config.limit} onChange={(e) => set('limit', Math.min(50, Math.max(2, Math.round(Number(e.target.value)) || DEFAULT_CONFIG.limit)))} />
          </label>
          <label className="inline">
            <input type="checkbox" checked={config.empty} onChange={(e) => set('empty', e.target.checked)} />
            {t('diagram.empty')}
          </label>
        </Section>
        <Section title={t('diagram.section.look')}>
          <label>
            {t('diagram.titleLabel')}
            <input type="text" value={config.title} dir="auto" onChange={(e) => set('title', e.target.value)} />
          </label>
          {config.type !== 'pie' && (
            <>
              <label>
                {t('diagram.xLabel')}
                <input type="text" value={config.xLabel} placeholder={effective.xLabel} dir="auto" onChange={(e) => set('xLabel', e.target.value)} />
              </label>
              <label>
                {t('diagram.yLabel')}
                <input type="text" value={config.yLabel} placeholder={effective.yLabel} dir="auto" onChange={(e) => set('yLabel', e.target.value)} />
              </label>
            </>
          )}
          <label>
            {t('diagram.palette')}
            <select value={config.palette} onChange={(e) => setConfig((c) => ({ ...c, palette: e.target.value as PaletteName, colors: {} }))}>
              {(Object.keys(PALETTES) as PaletteName[]).map((p) => (
                <option key={p} value={p}>
                  {t(`diagram.palette.${p}` as const)}
                </option>
              ))}
            </select>
          </label>
          <div className="diagram-colors">
            {keys.slice(0, 12).map((k, i) => (
              <label key={k} className="inline" title={k || t('diagram.papers')}>
                <input
                  type="color"
                  value={seriesColor(config, k, i)}
                  aria-label={t('diagram.color', { name: k || t('diagram.papers') })}
                  onChange={(e) => setConfig((c) => ({ ...c, colors: { ...c.colors, [k]: e.target.value } }))}
                />
                <span>{k || t('diagram.papers')}</span>
              </label>
            ))}
          </div>
          <label className="inline">
            <input type="checkbox" checked={config.legend} onChange={(e) => set('legend', e.target.checked)} />
            {t('diagram.legend')}
          </label>
          <label className="inline">
            <input type="checkbox" checked={config.values} onChange={(e) => set('values', e.target.checked)} />
            {t('diagram.values')}
          </label>
          <div className="diagram-size">
            <label>
              {t('diagram.width')}
              <input type="number" min={300} max={3000} step={50} value={config.width} onChange={(e) => set('width', Math.min(3000, Math.max(300, Number(e.target.value) || DEFAULT_CONFIG.width)))} />
            </label>
            <label>
              {t('diagram.height')}
              <input type="number" min={200} max={2000} step={50} value={config.height} onChange={(e) => set('height', Math.min(2000, Math.max(200, Number(e.target.value) || DEFAULT_CONFIG.height)))} />
            </label>
          </div>
          <button type="button" onClick={() => setConfig(DEFAULT_CONFIG)}>
            {t('diagram.reset')}
          </button>
        </Section>
        <Section title={t('diagram.section.export')}>
          <div className="diagram-export">
            {FORMATS.map((f) => (
              <button key={f} type="button" className="primary" disabled={!ready || busy} onClick={() => void save(f)}>
                {t(`diagram.export.${f}` as const)}
              </button>
            ))}
          </div>
          <p className="graph-hint">{t('diagram.exportHint')}</p>
          {message && (
            <p className={message.ok ? 'graph-hint' : 'graph-hint graph-error'} role="status">
              {message.text}
            </p>
          )}
        </Section>
      </aside>
      <div className="diagram-stage">
        <p className="graph-hint" role="status">
          {shown === null
            ? t('diagram.rendering')
            : 'error' in shown
              ? t('diagram.error', { message: shown.error })
              : shown.papers === 0
                ? t('diagram.noData')
                : t('diagram.count', { papers: shown.papers, cats: shown.categories })}
        </p>
        {shown && 'svg' in shown && (
          <img
            className="diagram-image"
            alt={effective.title || t('resultView.tab.diagram')}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(shown.svg)}`}
            style={{ aspectRatio: `${effective.width} / ${effective.height}` }}
          />
        )}
      </div>
    </div>
  )
}
