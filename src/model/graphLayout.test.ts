// [utest->req~ui-210~1]
import { describe, it, expect } from 'vitest'
import { createLayout, layoutHost, layoutSettings, type LayoutFrame } from './graphLayout'

/** Random graph with about two edges per node, the same on each run. */
function randomLinks(n: number, perNode = 2): Uint32Array {
  let seed = 42
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const links = new Uint32Array(n * perNode * 2)
  for (let e = 0; e < n * perNode; e++) {
    links[2 * e] = e % n
    links[2 * e + 1] = Math.floor(rand() * n)
  }
  return links
}

const unplaced = (n: number) => new Float32Array(n).fill(NaN)

function collect() {
  const frames: LayoutFrame[] = []
  let wake = () => {}
  const post = (f: LayoutFrame) => {
    frames.push(f)
    wake()
  }
  const until = (test: (f: LayoutFrame) => boolean) =>
    new Promise<LayoutFrame>((resolve) => {
      wake = () => {
        const f = frames.at(-1)!
        if (test(f)) resolve(f)
      }
      wake()
    })
  return { frames, post, until }
}

describe('layoutSettings', () => {
  it('uses fewer ticks and a coarser Barnes-Hut theta for big graphs', () => {
    expect(layoutSettings(100)).toMatchObject({ ticks: 300, theta: 0.9 })
    expect(layoutSettings(10_000)).toMatchObject({ ticks: 95, theta: 1.5 })
    expect(layoutSettings(50_000)).toMatchObject({ ticks: 80, theta: 2 })
    const { ticks, alphaDecay } = layoutSettings(50_000)
    expect(Math.pow(1 - alphaDecay, ticks)).toBeCloseTo(0.001)
  })
})

describe('layoutHost', () => {
  it('streams positions for the current start and stops when cooled', async () => {
    const { frames, post, until } = collect()
    const send = layoutHost(post, 1)
    send({ type: 'drag', i: 0, x: 0, y: 0 })
    expect(frames).toEqual([])
    const x = unplaced(3)
    x[0] = 500
    const y = new Float32Array([500, NaN, NaN])
    send({ type: 'start', gen: 7, x, y, links: new Uint32Array([0, 1, 1, 2]), alpha: 1 })
    expect(frames).toHaveLength(1)
    const last = await until((f) => f.done)
    expect(frames.every((f) => f.gen === 7)).toBe(true)
    expect([...last.x].every(Number.isFinite)).toBe(true)
    expect(Math.hypot(last.x[0] - last.x[1], last.y[0] - last.y[1])).toBeLessThan(200)
  })

  it('pins a dragged node until release and ignores unknown nodes', async () => {
    const { frames, post, until } = collect()
    const send = layoutHost(post, 1)
    send({ type: 'start', gen: 1, x: unplaced(2), y: unplaced(2), links: new Uint32Array([0, 1]), alpha: 1 })
    await until((f) => f.done)
    send({ type: 'drag', i: 9, x: 0, y: 0 })
    send({ type: 'drag', i: 0, x: 300, y: -300 })
    const pinned = await until((f) => !f.done && f.x[0] === 300)
    expect(pinned.y[0]).toBe(-300)
    send({ type: 'release', i: 0 })
    await until((f) => f.done)
    const count = frames.length
    send({ type: 'release', i: 0 })
    send({ type: 'stop' })
    await new Promise((r) => setTimeout(r, 20))
    expect(frames).toHaveLength(count)
  })
})

// Budgets are about 10× the times measured on a laptop, so slow CI runners do not fail them.
describe('layout performance', () => {
  it('settles a 10k node graph', () => {
    const n = 10_000
    const { sim } = createLayout({ x: unplaced(n), y: unplaced(n), links: randomLinks(n), alpha: 1 })
    let ticks = 0
    while (sim.alpha() >= sim.alphaMin()) {
      sim.tick()
      ticks++
    }
    // Tick count, not wall time: the run takes 1.6 s alone but up to 30 s
    // beside the other test files under coverage, so a time budget flakes.
    expect(ticks).toBe(layoutSettings(n).ticks)
  }, 60_000)

  it('ticks a 50k node graph to finite positions', () => {
    const n = 50_000
    const { sim } = createLayout({ x: unplaced(n), y: unplaced(n), links: randomLinks(n), alpha: 1 })
    for (let i = 0; i < 3; i++) sim.tick()
    const nodes = sim.nodes()
    expect(nodes).toHaveLength(n)
    expect(nodes.every((d) => Number.isFinite(d.x) && Number.isFinite(d.y))).toBe(true)
  }, 120_000)
})
