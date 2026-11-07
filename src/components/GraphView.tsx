// [impl->req~ui-190~1]
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from 'react'
import { useStore } from '../state/store'
import { getPlatform } from '../platform'
import { buildGraph, defaultGraphSeat, graphTrees, type Graph } from '../model/graph'
import { indexGraph, neighbours, parseQuery, selectSubgraph, type GraphQuery, type SubGraph } from '../model/graphQuery'
import {
  CypherError,
  MAX_ROWS,
  cypherHost,
  cypherSubgraph,
  isCypher,
  parseCypher,
  type CypherOutput,
  type CypherQuery,
  type CypherReply,
  type CypherRequest,
} from '../model/graphCypher'
import { layoutHost, type LayoutFrame, type LayoutMessage } from '../model/graphLayout'
import { buildScene, drawScene, EDGE_DASH, EDGE_TYPES, edgeAt, fitView, hitTest, selectNode, zoomAt, type Palette, type Scene } from './graphCanvas'
import { useT } from '../i18n'
import { Modal } from './Modal'
import { ExportGraphDialog } from './ExportGraphDialog'
import { GraphSeatSelect } from './GraphSeatSelect'
import { GraphDownload, type SaveResult } from './GraphDownload'
import { imageFrame, sceneToPng, sceneToSvg, type ImageArea, type ImageFormat } from './graphImage'

const LIST_PAGE = 200
export const CYPHER_TIMEOUT_MS = 20_000
const NOTHING: SubGraph = { nodes: [], edges: [], seeds: new Set() }
const EDGE_VARS = ['--graph-answer', '--graph-authored', '--graph-venue', '--graph-keyword', '--graph-cites']

function readPalette(el: Element): Palette {
  const css = getComputedStyle(el)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return { edges: EDGE_VARS.map(v), text: v('--text'), selected: v('--danger'), groups: [v('--accent'), v('--ok'), v('--progress'), v('--ai-mark')] }
}

interface CypherWorker {
  post: (m: CypherRequest) => void
  stop: () => void
  /** The graph the worker has indexed. */
  graph?: Graph
}

// [impl->req~ui-250~1]
function startCypherWorker(onReply: (r: CypherReply) => void): CypherWorker {
  // jsdom has no Worker; there the query runs inline with the same code.
  if (typeof Worker === 'undefined') return { post: cypherHost(onReply), stop: () => {} }
  const worker = new Worker(new URL('../model/graphCypher.worker.ts', import.meta.url), { type: 'module' })
  let live = true
  worker.onmessage = (e: MessageEvent<CypherReply>) => {
    if (live) onReply(e.data)
  }
  worker.onerror = (e) => {
    if (live) onReply({ error: e.message })
  }
  return {
    post: (m) => worker.postMessage(m),
    stop: () => {
      live = false
      worker.terminate()
    },
  }
}

/** Renders LIST_PAGE items at a time, so the accessible lists stay fast for huge graphs. */
function PagedList<T>({ items, render }: { items: T[]; render: (item: T, i: number) => ReactNode }) {
  const t = useT()
  const [cap, setCap] = useState(LIST_PAGE)
  return (
    <>
      <ul className="graph-list">{items.slice(0, cap).map(render)}</ul>
      {items.length > cap && (
        <button type="button" onClick={() => setCap((c) => c + LIST_PAGE)}>
          {t('graphView.more', { shown: cap, total: items.length })}
        </button>
      )}
    </>
  )
}

export function GraphView({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)
  const theme = useStore((s) => s.theme)
  const t = useT()
  const [seat, setSeat] = useState(() => (project ? defaultGraphSeat(project) : '1'))
  const [listOpen, setListOpen] = useState(false)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState<GraphQuery | CypherQuery>(() => parseQuery(''))
  const [error, setError] = useState<CypherError | null>(null)
  const [pending, setPending] = useState<CypherQuery | null>(null)
  const [cypher, setCypher] = useState<{ graph: Graph; out: CypherOutput } | null>(null)
  const [running, setRunning] = useState(false)
  const [extra, setExtra] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [hidden, setHidden] = useState(0)
  const [exportOpen, setExportOpen] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const view = useRef({ x: 0, y: 0, k: 1 }).current
  const sceneRef = useRef<Scene | null>(null)
  const layout = useRef<(m: LayoutMessage) => void>(() => {})
  const gen = useRef(0)
  const frame = useRef(0)
  const palette = useRef<Palette | null>(null)
  const drag = useRef<{ i: number; x: number; y: number; moved: boolean } | null>(null)
  const cypherWorker = useRef<CypherWorker | null>(null)
  const onReply = useRef<(r: CypherReply) => void>(() => {})

  const index = useMemo(
    () => indexGraph(project ? buildGraph(project, graphTrees(project, seat)) : { nodes: [], edges: [] }),
    [project, seat],
  )
  const result = 'chains' in query && cypher?.graph === index.graph ? cypher.out : null
  /** The Cypher query to run: a new one, or the shown one again after the graph changed. */
  const job = pending ?? ('chains' in query && !result ? query : null)
  const sub = useMemo(
    () => (result ? cypherSubgraph(index, result, extra) : 'chains' in query ? NOTHING : selectSubgraph(index, query, extra)),
    [index, query, result, extra],
  )
  const scene = useMemo(
    () => buildScene(sub, 'chains' in query || query.terms.length > 0, sceneRef.current, (id) => neighbours(index, id)),
    [sub, query, index],
  )

  const requestDraw = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const c = canvasRef.current
      const s = sceneRef.current
      const ctx = c?.getContext('2d')
      if (!c || !s || !ctx) return
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth
      const h = c.clientHeight
      if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr)
      if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr)
      palette.current ??= readPalette(c)
      drawScene(ctx, s, view, w, h, dpr, palette.current)
    })
  }, [view])

  useEffect(() => {
    const onFrame = (f: LayoutFrame) => {
      const s = sceneRef.current
      if (!s || f.gen !== gen.current) return
      s.xs = f.x
      s.ys = f.y
      s.version++
      requestDraw()
    }
    // jsdom has no Worker; there the layout runs inline with the same code.
    const worker = typeof Worker === 'undefined' ? undefined : new Worker(new URL('../model/graphLayout.worker.ts', import.meta.url), { type: 'module' })
    if (worker) worker.onmessage = (e: MessageEvent<LayoutFrame>) => onFrame(e.data)
    const send = worker ? (m: LayoutMessage) => worker.postMessage(m) : layoutHost(onFrame)
    layout.current = send
    const canvas = canvasRef.current
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(requestDraw)
    if (canvas) resize?.observe(canvas)
    return () => {
      send({ type: 'stop' })
      worker?.terminate()
      resize?.disconnect()
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [requestDraw])

  // [impl->req~ui-250~1]
  useEffect(() => {
    if (!job) return
    const graph = index.graph
    let live = true
    const end = () => {
      live = false
      clearTimeout(timer)
      onReply.current = () => {}
      setRunning(false)
    }
    const stop = () => {
      cypherWorker.current?.stop()
      cypherWorker.current = null
    }
    const fail = (e: CypherError) => {
      end()
      stop()
      setPending(null)
      setError(e)
    }
    onReply.current = (r) => {
      if ('error' in r) return fail(new CypherError('graphView.cypher.failed', { message: r.error }))
      end()
      setPending(null)
      setQuery(job)
      setCypher({ graph, out: r.out })
      setError(null)
    }
    const timer = setTimeout(() => fail(new CypherError('graphView.cypher.timeout', { seconds: CYPHER_TIMEOUT_MS / 1000 })), CYPHER_TIMEOUT_MS)
    setRunning(true)
    const w = (cypherWorker.current ??= startCypherWorker((r) => onReply.current(r)))
    if (w.graph !== graph) {
      w.post({ type: 'graph', graph })
      w.graph = graph
    }
    w.post({ type: 'query', query: job })
    return () => {
      if (!live) return
      end()
      stop()
    }
  }, [index, job])

  useEffect(
    () => () => {
      cypherWorker.current?.stop()
      cypherWorker.current = null
    },
    [],
  )

  // [impl->req~ui-220~1]
  useEffect(() => {
    palette.current = null
    requestDraw()
  }, [theme, requestDraw])

  useEffect(() => {
    sceneRef.current = scene
    gen.current++
    const placed = scene.xs.some((x) => !Number.isNaN(x))
    layout.current({ type: 'start', gen: gen.current, x: scene.xs, y: scene.ys, links: scene.edges, alpha: placed ? 0.5 : 1 })
    requestDraw()
  }, [scene, requestDraw])

  useEffect(() => {
    scene.hidden = hidden
    scene.hover = -1
    selectNode(scene, selected === null ? -1 : (scene.indexOf.get(selected) ?? -1))
    requestDraw()
  }, [scene, selected, hidden, requestDraw])

  const size = () => ({ w: canvasRef.current?.clientWidth ?? 0, h: canvasRef.current?.clientHeight ?? 0 })
  const resetView = () => {
    const { w, h } = size()
    fitView(view, sceneRef.current, w, h)
    requestDraw()
  }
  useLayoutEffect(resetView, [])

  const zoom = (factor: number) => {
    const { w, h } = size()
    zoomAt(view, w / 2, h / 2, factor)
    requestDraw()
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      zoomAt(view, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.002))
      requestDraw()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [view, requestDraw])

  useEffect(() => {
    if (exportOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, exportOpen])

  if (!project) return null
  const node = selected ? index.byId.get(selected) : undefined

  const run = (e: FormEvent) => {
    e.preventDefault()
    try {
      if (isCypher(input)) setPending(parseCypher(input))
      else {
        setPending(null)
        setQuery(parseQuery(input))
      }
    } catch (err) {
      if (!(err instanceof CypherError)) throw err
      setError(err)
      return
    }
    setError(null)
    setExtra([])
    setSelected(null)
  }
  const reveal = (ids: string[]) => {
    const add = ids.filter((id) => !scene.indexOf.has(id))
    if (add.length > 0) setExtra((prev) => [...prev, ...add])
  }
  const focusNode = (id: string) => {
    reveal([id])
    setSelected(id)
    const i = scene.indexOf.get(id)
    if (i === undefined || Number.isNaN(scene.xs[i])) return
    const { w, h } = size()
    view.x = w / 2 - scene.xs[i] * view.k
    view.y = h / 2 - scene.ys[i] * view.k
    requestDraw()
  }
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return [(e.clientX - r.left - view.x) / view.k, (e.clientY - r.top - view.y) / view.k] as const
  }
  const nodeAt = (e: { clientX: number; clientY: number }) => hitTest(scene, ...toWorld(e), view.k)

  // [impl->req~ui-260~1]
  const saveImage = async (format: ImageFormat, area: ImageArea): Promise<SaveResult> => {
    const canvas = canvasRef.current
    const s = sceneRef.current
    if (!canvas || !s) return null
    try {
      const platform = getPlatform()
      const path = await platform.pickTextExportPath(`knowledge-graph.${format}`, format)
      if (!path) return null
      const frame = imageFrame(s, view, canvas.clientWidth, canvas.clientHeight, area)
      palette.current ??= readPalette(canvas)
      const background = getComputedStyle(canvas).getPropertyValue('--bg').trim() || '#ffffff'
      const res =
        format === 'svg'
          ? await platform.writeTextFile(path, sceneToSvg(s, frame, palette.current, background))
          : await platform.writeBinaryFile(path, await sceneToPng(s, frame, palette.current, background, window.devicePixelRatio || 1))
      return res.ok ? { ok: true, text: t('app.export.saved', { path: res.path }) } : { ok: false, text: t('app.export.saveFailed', { error: res.error }) }
    } catch (err) {
      return { ok: false, text: t('app.export.saveFailed', { error: String(err) }) }
    }
  }

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    drag.current = { i: nodeAt(e), x: e.clientX, y: e.clientY, moved: false }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d) {
      const n = index.byId.get(scene.ids[nodeAt(e)])
      const hover = n ? -1 : edgeAt(scene, ...toWorld(e), view.k)
      const edge = scene.edgeList[hover]
      const title = n
        ? `${t(`graphView.type.${n.type}` as const)}: ${n.label}`
        : edge
          ? t('graphView.edgeTitle', {
              type: t(`graphView.edge.${edge.type}` as const) + (edge.field ? ` (${edge.field})` : ''),
              source: index.byId.get(edge.source)?.label ?? '',
              target: index.byId.get(edge.target)?.label ?? '',
            })
          : ''
      if (e.currentTarget.title !== title) e.currentTarget.title = title
      if (scene.hover !== hover) {
        scene.hover = hover
        requestDraw()
      }
      return
    }
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    d.moved = true
    if (d.i >= 0) {
      const [wx, wy] = toWorld(e)
      scene.xs[d.i] = wx
      scene.ys[d.i] = wy
      scene.version++
      layout.current({ type: 'drag', i: d.i, x: wx, y: wy })
    } else {
      view.x += dx
      view.y += dy
      d.x = e.clientX
      d.y = e.clientY
    }
    requestDraw()
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d || d.i < 0) return
    if (!d.moved) setSelected(scene.ids[d.i])
    else layout.current({ type: 'release', i: d.i })
  }

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
          <GraphSeatSelect project={project} value={seat} onChange={setSeat} />
          <div className="graph-zoom" role="group" aria-label={t('graphView.zoom')}>
            <button type="button" onClick={() => zoom(1.25)} aria-label={t('graphView.zoomIn')} title={t('graphView.zoomIn')}>
              +
            </button>
            <button type="button" onClick={() => zoom(0.8)} aria-label={t('graphView.zoomOut')} title={t('graphView.zoomOut')}>
              −
            </button>
            <button type="button" onClick={resetView}>
              {t('graphView.reset')}
            </button>
          </div>
        </div>
        {/* [impl->req~ui-220~1] */}
        <fieldset className="graph-legend">
          <legend>{t('graphView.relations')}</legend>
          {EDGE_TYPES.map((type, i) => (
            <label key={type}>
              <input type="checkbox" checked={!(hidden & (1 << i))} onChange={() => setHidden((h) => h ^ (1 << i))} />
              <svg width="28" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="28" y2="4" style={{ stroke: `var(${EDGE_VARS[i]})` }} strokeWidth="2" strokeDasharray={EDGE_DASH[i].join(' ') || undefined} />
              </svg>
              {t(`graphView.edge.${type}` as const)}
            </label>
          ))}
        </fieldset>
        <p id="graph-query-help" className="graph-hint">
          {t('graphView.help')} {t('graphView.cypherHelp')}
        </p>
        {error && (
          <p className="graph-hint graph-error" role="alert">
            {t('graphView.cypher.error', { message: t(error.key, error.params) })}
          </p>
        )}
        <p className="graph-hint" role="status">
          {running
            ? t('graphView.cypher.running')
            : sub.nodes.length === 0
              ? t('graphView.empty')
              : t('graphView.count', { nodes: sub.nodes.length, edges: sub.edges.length })}
        </p>
        <div className="graph-body">
          <div className="graph-stage">
            <canvas
              ref={canvasRef}
              className="graph-canvas"
              role="img"
              aria-label={t('graphView.count', { nodes: sub.nodes.length, edges: sub.edges.length })}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={(e) => {
                const i = nodeAt(e)
                if (i >= 0) reveal(neighbours(index, scene.ids[i]))
              }}
            />
            <GraphDownload disabled={sub.nodes.length === 0} onSave={saveImage} />
          </div>
          <button
            type="button"
            className="graph-nodes-toggle"
            aria-expanded={listOpen}
            aria-controls="graph-nodes-drawer"
            onClick={() => setListOpen((o) => !o)}
          >
            {t('graphView.nodes')} ({sub.nodes.length})
          </button>
          {listOpen && (
            <nav id="graph-nodes-drawer" className="graph-nodes" aria-label={t('graphView.nodes')}>
              <PagedList
                items={sub.nodes}
                render={(n) => (
                  <li key={n.id}>
                    <button type="button" aria-pressed={selected === n.id} onClick={() => focusNode(n.id)}>
                      <span className="graph-hint">{t(`graphView.type.${n.type}` as const)} </span>
                      <span dir="auto">{n.label}</span>
                    </button>
                  </li>
                )}
              />
            </nav>
          )}
          <aside className="graph-side">
            {result && (
              <section aria-labelledby="graph-results-title">
                <h3 id="graph-results-title">{t('graphView.cypher.results', { count: result.rows.length })}</h3>
                {result.truncated && <p className="graph-hint">{t('graphView.cypher.truncated', { max: MAX_ROWS })}</p>}
                {result.rows.length > LIST_PAGE && <p className="graph-hint">{t('graphView.cypher.shown', { shown: LIST_PAGE })}</p>}
                <div className="graph-results">
                  <table>
                    <thead>
                      <tr>
                        {result.columns.map((c, i) => (
                          <th key={i} scope="col" dir="auto">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(0, LIST_PAGE).map((row, r) => (
                        <tr key={r}>
                          {row.map((v, c) => (
                            <td key={c} dir="auto">
                              {v}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
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
                <PagedList
                  key={node.id}
                  items={index.adjacent.get(node.id) ?? []}
                  render={(e, i) => {
                    const other = e.source === node.id ? e.target : e.source
                    return (
                      <li key={i}>
                        <button type="button" onClick={() => focusNode(other)}>
                          <span className="graph-hint">{e.field ?? e.type} </span>
                          <span dir="auto">{index.byId.get(other)?.label}</span>
                        </button>
                      </li>
                    )
                  }}
                />
              </section>
            ) : (
              <p className="graph-hint">{t('graphView.noSelection')}</p>
            )}
          </aside>
        </div>
      </Modal>
      {exportOpen && <ExportGraphDialog onClose={() => setExportOpen(false)} />}
    </>
  )
}
