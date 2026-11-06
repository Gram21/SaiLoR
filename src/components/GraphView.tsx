// [impl->req~ui-190~1]
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from 'd3-force'
import { useStore } from '../state/store'
import { seatLabel } from '../model/project'
import { buildGraph, graphSource, graphTrees } from '../model/graph'
import { indexGraph, neighbours, parseQuery, selectSubgraph } from '../model/graphQuery'
import { useT } from '../i18n'
import { Modal } from './Modal'
import { ExportGraphDialog } from './ExportGraphDialog'

interface SimNode extends SimulationNodeDatum {
  id: string
}

// ponytail: SVG with one element per node; past a few hundred nodes this gets slow, use canvas if bigger views are needed.
const LIMIT = 300

const short = (s: string) => (s.length > 28 ? `${s.slice(0, 27)}…` : s)

export function GraphView({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)
  const t = useT()
  const [seat, setSeat] = useState('1')
  const [input, setInput] = useState('')
  const [query, setQuery] = useState(() => parseQuery(''))
  const [extra, setExtra] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [, setFrame] = useState(0)
  const svgRef = useRef<SVGSVGElement>(null)
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null)
  const posRef = useRef(new Map<string, SimNode>())
  const drag = useRef<{ id: string | null; x: number; y: number; moved: boolean } | null>(null)

  const index = useMemo(
    () => indexGraph(project ? buildGraph(project, graphTrees(project, seat)) : { nodes: [], edges: [] }),
    [project, seat],
  )
  const sub = useMemo(() => selectSubgraph(index, query, LIMIT, extra), [index, query, extra])

  const sim = useMemo(() => {
    const old = posRef.current
    const next = new Map<string, SimNode>()
    for (const n of sub.nodes) {
      const kept = old.get(n.id)
      const near = kept ? undefined : neighbours(index, n.id).map((id) => old.get(id)).find((p) => p?.x !== undefined)
      next.set(n.id, kept ?? (near ? { id: n.id, x: near.x! + 10, y: near.y! + 10 } : { id: n.id }))
    }
    posRef.current = next
    return next
  }, [sub, index])

  useEffect(() => {
    const nodes = [...sim.values()]
    const placed = nodes.some((n) => n.x !== undefined)
    const s = forceSimulation(nodes)
      .force('charge', forceManyBody().strength(-150))
      .force('link', forceLink<SimNode, { source: string; target: string }>(sub.edges.map((e) => ({ source: e.source, target: e.target }))).id((d) => d.id).distance(60))
      .force('x', forceX(0).strength(0.05))
      .force('y', forceY(0).strength(0.05))
      .alpha(placed ? 0.5 : 1)
      .stop()
    for (let i = 0; i < 300 && s.alpha() > s.alphaMin(); i++) s.tick()
    s.on('tick', () => setFrame((f) => f + 1))
    simRef.current = s
    setFrame((f) => f + 1)
    return () => {
      s.stop()
      s.on('tick', null)
    }
  }, [sim, sub.edges])

  const center = () => {
    const r = svgRef.current?.getBoundingClientRect()
    return { cx: (r?.width ?? 0) / 2, cy: (r?.height ?? 0) / 2 }
  }
  const resetView = () => {
    const { cx, cy } = center()
    setView({ x: cx, y: cy, k: 1 })
  }
  useLayoutEffect(resetView, [])

  const zoomAt = (px: number, py: number, factor: number) =>
    setView((v) => {
      const k = Math.min(4, Math.max(0.1, v.k * factor))
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
    })

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.002))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    if (exportOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, exportOpen])

  if (!project) return null
  const source = graphSource(project)
  const node = selected ? index.byId.get(selected) : undefined

  const run = (e: FormEvent) => {
    e.preventDefault()
    setQuery(parseQuery(input))
    setExtra([])
    setSelected(null)
  }
  const reveal = (ids: string[]) => setExtra((prev) => [...new Set([...prev, ...ids])])
  const focusNode = (id: string) => {
    reveal([id])
    setSelected(id)
    const p = sim.get(id)
    if (p?.x !== undefined) {
      const { cx, cy } = center()
      setView((v) => ({ ...v, x: cx - p.x! * v.k, y: cy - p.y! * v.k }))
    }
  }
  const idAt = (target: EventTarget) => (target as Element).closest?.('[data-id]')?.getAttribute('data-id') ?? null

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    drag.current = { id: idAt(e.target), x: e.clientX, y: e.clientY, moved: false }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    d.moved = true
    const n = d.id ? sim.get(d.id) : undefined
    if (n) {
      const r = e.currentTarget.getBoundingClientRect()
      n.fx = (e.clientX - r.left - view.x) / view.k
      n.fy = (e.clientY - r.top - view.y) / view.k
      simRef.current?.alphaTarget(0.3).restart()
    } else {
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
      d.x = e.clientX
      d.y = e.clientY
    }
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    const n = d?.id ? sim.get(d.id) : undefined
    if (!d?.id || !n) return
    if (!d.moved) setSelected(d.id)
    n.fx = null
    n.fy = null
    simRef.current?.alphaTarget(0)
  }

  const pos = (id: string) => sim.get(id) ?? { x: 0, y: 0 }

  return (
    <>
      <Modal className="graph-view" aria-label={t('graphView.title')}>
        <div className="modal-head">
          <strong>{t('graphView.title')}</strong>
          <div className="modal-head-actions">
            <button type="button" onClick={() => setExportOpen(true)}>
              {t('graphView.export')}
            </button>
            <button type="button" className="icon-btn" title={t('common.close')} onClick={onClose} aria-label={t('common.close')}>
              ×
            </button>
          </div>
        </div>
        <div className="graph-toolbar">
          <form className="graph-query" onSubmit={run} role="search">
            <input
              type="search"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('graphView.placeholder')}
              aria-label={t('graphView.query')}
              aria-describedby="graph-query-help"
              dir="auto"
            />
            <button type="submit">{t('graphView.run')}</button>
          </form>
          {source === 'seat' && (
            <label>
              <span>{t('exportGraph.seat')} </span>
              <select value={seat} onChange={(e) => setSeat(e.target.value)}>
                {Array.from({ length: project.reviewers }, (_, i) => String(i + 1)).map((s) => (
                  <option key={s} value={s}>
                    {seatLabel(project, s)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="graph-zoom" role="group" aria-label={t('graphView.zoom')}>
            <button type="button" onClick={() => zoomAt(center().cx, center().cy, 1.25)} aria-label={t('graphView.zoomIn')} title={t('graphView.zoomIn')}>
              +
            </button>
            <button type="button" onClick={() => zoomAt(center().cx, center().cy, 0.8)} aria-label={t('graphView.zoomOut')} title={t('graphView.zoomOut')}>
              −
            </button>
            <button type="button" onClick={resetView}>
              {t('graphView.reset')}
            </button>
          </div>
        </div>
        <p id="graph-query-help" className="graph-hint">
          {t('graphView.help')}
        </p>
        <p className="graph-hint" role="status">
          {sub.nodes.length === 0
            ? t('graphView.empty')
            : sub.total > LIMIT
              ? t('graphView.truncated', { shown: LIMIT, total: sub.total })
              : t('graphView.count', { nodes: sub.nodes.length, edges: sub.edges.length })}
        </p>
        <div className="graph-body">
          <svg
            ref={svgRef}
            className="graph-canvas"
            role="img"
            aria-label={t('graphView.count', { nodes: sub.nodes.length, edges: sub.edges.length })}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(e) => {
              const id = idAt(e.target)
              if (id) reveal(neighbours(index, id))
            }}
          >
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {sub.edges.map((e, i) => {
                const a = pos(e.source)
                const b = pos(e.target)
                return (
                  <line key={i} className="graph-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y}>
                    <title>{e.field ?? e.type}</title>
                  </line>
                )
              })}
              {sub.nodes.map((n) => {
                const p = pos(n.id)
                const cls = `graph-node graph-node-${n.type.toLowerCase()}${sub.seeds.has(n.id) && query.terms.length > 0 ? ' is-match' : ''}${selected === n.id ? ' is-selected' : ''}`
                return (
                  <g key={n.id} data-id={n.id} className={cls} transform={`translate(${p.x ?? 0},${p.y ?? 0})`}>
                    <circle r={n.type === 'Paper' ? 9 : 6} />
                    <text y={-12} textAnchor="middle">
                      {short(n.label)}
                    </text>
                    <title>{`${t(`graphView.type.${n.type}` as const)}: ${n.label}`}</title>
                  </g>
                )
              })}
            </g>
          </svg>
          <aside className="graph-side">
            {node ? (
              <section aria-labelledby="graph-detail-title">
                <h3 id="graph-detail-title" dir="auto">
                  {node.label}
                </h3>
                <p className="graph-hint">
                  {t(`graphView.type.${node.type}` as const)}
                  {node.field ? ` · ${node.field}` : ''}
                </p>
                <dl className="graph-values">
                  {node.doi && (
                    <>
                      <dt>DOI</dt>
                      <dd>{node.doi}</dd>
                    </>
                  )}
                  {node.year !== undefined && (
                    <>
                      <dt>{t('graphView.year')}</dt>
                      <dd>{node.year}</dd>
                    </>
                  )}
                  {Object.entries(node.values).map(([f, vs]) => (
                    <div key={f}>
                      <dt>{f}</dt>
                      <dd dir="auto">{vs.join('; ')}</dd>
                    </div>
                  ))}
                </dl>
                <button type="button" onClick={() => reveal(neighbours(index, node.id))}>
                  {t('graphView.expand')}
                </button>
                <h4>{t('graphView.neighbours')}</h4>
                <ul className="graph-list">
                  {(index.adjacent.get(node.id) ?? []).map((e, i) => {
                    const other = e.source === node.id ? e.target : e.source
                    return (
                      <li key={i}>
                        <button type="button" onClick={() => focusNode(other)}>
                          <span className="graph-hint">{e.field ?? e.type} </span>
                          <span dir="auto">{index.byId.get(other)?.label}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : (
              <p className="graph-hint">{t('graphView.noSelection')}</p>
            )}
            <h3>{t('graphView.nodes')}</h3>
            <ul className="graph-list">
              {sub.nodes.map((n) => (
                <li key={n.id}>
                  <button type="button" aria-pressed={selected === n.id} onClick={() => focusNode(n.id)}>
                    <span className="graph-hint">{t(`graphView.type.${n.type}` as const)} </span>
                    <span dir="auto">{n.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </Modal>
      {exportOpen && <ExportGraphDialog onClose={() => setExportOpen(false)} />}
    </>
  )
}
