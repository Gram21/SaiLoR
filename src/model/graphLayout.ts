import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from 'd3-force'

// [impl->req~ui-210~1]
/** Starts a layout. Positions are NaN for nodes without a position; `links` holds node index pairs. */
export interface LayoutStart {
  type: 'start'
  gen: number
  x: Float32Array
  y: Float32Array
  links: Uint32Array
  alpha: number
}
export type LayoutMessage = LayoutStart | { type: 'drag'; i: number; x: number; y: number } | { type: 'release'; i: number } | { type: 'stop' }
export interface LayoutFrame {
  gen: number
  x: Float32Array
  y: Float32Array
  done: boolean
}

/** Cheaper forces and fewer ticks for big graphs, so a 50k node layout settles in seconds, not minutes. */
export function layoutSettings(n: number) {
  const ticks = n <= 1000 ? 300 : Math.max(80, Math.round(300 * Math.sqrt(1000 / n)))
  const theta = n > 20000 ? 2 : n > 2000 ? 1.5 : 0.9
  return { ticks, theta, alphaDecay: 1 - Math.pow(0.001, 1 / ticks) }
}

export function createLayout(start: Omit<LayoutStart, 'type' | 'gen'>) {
  const n = start.x.length
  const nodes: SimulationNodeDatum[] = []
  for (let i = 0; i < n; i++) nodes.push(Number.isNaN(start.x[i]) ? {} : { x: start.x[i], y: start.y[i] })
  const links: { source: number; target: number }[] = []
  for (let e = 0; e < start.links.length; e += 2) links.push({ source: start.links[e], target: start.links[e + 1] })
  const s = layoutSettings(n)
  const sim: Simulation<SimulationNodeDatum, undefined> = forceSimulation(nodes)
    .stop()
    .force('charge', forceManyBody().strength(-150).theta(s.theta))
    .force('link', forceLink(links).distance(60))
    .force('x', forceX(0).strength(0.05))
    .force('y', forceY(0).strength(0.05))
    .alpha(start.alpha)
    .alphaDecay(s.alphaDecay)
  return { sim, nodes }
}

const cooled = (sim: Simulation<SimulationNodeDatum, undefined>) => sim.alpha() < sim.alphaMin() && sim.alphaTarget() < sim.alphaMin()

/**
 * Runs layouts message by message, in a worker or inline. Each step ticks for at most `budgetMs`
 * (at least one tick), posts the positions and yields, so drag messages get through. Stops when cooled.
 */
export function layoutHost(post: (frame: LayoutFrame, transfer: Transferable[]) => void, budgetMs = 12) {
  let layout: ReturnType<typeof createLayout> | undefined
  let gen = 0
  let pending: ReturnType<typeof setTimeout> | undefined
  const run = () => {
    pending = undefined
    if (!layout) return
    const { sim, nodes } = layout
    const end = performance.now() + budgetMs
    do sim.tick()
    while (!cooled(sim) && performance.now() < end)
    const x = new Float32Array(nodes.length)
    const y = new Float32Array(nodes.length)
    for (let i = 0; i < nodes.length; i++) {
      x[i] = nodes[i].x!
      y[i] = nodes[i].y!
    }
    const done = cooled(sim)
    post({ gen, x, y, done }, [x.buffer, y.buffer])
    if (!done) pending = setTimeout(run, 0)
  }
  const kick = () => {
    if (pending === undefined) pending = setTimeout(run, 0)
  }
  return (m: LayoutMessage) => {
    if (m.type === 'start') {
      clearTimeout(pending)
      gen = m.gen
      layout = createLayout(m)
      run()
      return
    }
    if (m.type === 'stop') {
      clearTimeout(pending)
      pending = undefined
      layout = undefined
      return
    }
    const node = layout?.nodes[m.i]
    if (!layout || !node) return
    const drag = m.type === 'drag'
    node.fx = drag ? m.x : null
    node.fy = drag ? m.y : null
    layout.sim.alphaTarget(drag ? 0.3 : 0)
    kick()
  }
}
