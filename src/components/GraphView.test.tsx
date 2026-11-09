// [utest->req~ui-190~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const saved = vi.hoisted(() => ({ picks: [] as unknown[][], writes: [] as unknown[][] }))

vi.mock('../platform', () => ({
  getPlatform: () => ({
    pickTextExportPath: async (...a: unknown[]) => (saved.picks.push(a), '/out/graph'),
    writeTextFile: async (...a: unknown[]) => (saved.writes.push(a), { ok: true, path: '/out/graph' }),
    kind: 'electron',
    getRecents: () => [],
    rememberProject: () => {},
    forgetRecent: () => [],
    checkRecents: async (e: unknown[]) => e,
    getOsInfo: () => null,
  }),
}))

if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {}
  // @ts-expect-error test-only polyfill
  window.PointerEvent = PointerEventPolyfill
}

const { useStore } = await import('../state/store')
const { GraphView, CYPHER_TIMEOUT_MS } = await import('./GraphView')
const { layoutHost } = await import('../model/graphLayout')
const { cypherHost } = await import('../model/graphCypher')

/** Worker stand-in: the layout runs inline; Cypher replies wait until `flush`, like a real worker thread. */
class FakeWorker {
  static cypher: FakeWorker[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  sent: { type: string }[] = []
  replies: unknown[] = []
  terminate = vi.fn()
  postMessage: (m: never) => void
  constructor(url: URL) {
    if (String(url).includes('graphLayout')) {
      this.postMessage = layoutHost((data) => this.onmessage?.({ data }))
      return
    }
    FakeWorker.cypher.push(this)
    const host = cypherHost((r) => this.replies.push(r))
    this.postMessage = (m: { type: string }) => {
      this.sent.push(m)
      host(m as never)
    }
  }
  flush() {
    act(() => this.replies.splice(0).forEach((data) => this.onmessage?.({ data })))
  }
}

function open(reviewers = 1) {
  useStore.getState().loadFromText(
    JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'Method', type: 'string', options: ['Survey', 'Experiment'] }], reviewers },
      papers: [
        { id: 'p1', title: 'Graph Mining', authors: ['Ada Lovelace'], pdf: 'a.pdf', annotations: reviewers > 1 ? {} : { Method: [{ value: 'Survey' }] } },
        {
          id: 'p2',
          title: 'Testing Things',
          authors: ['Ada Lovelace', 'Alan Turing'],
          pdf: 'b.pdf',
          annotations: reviewers > 1 ? {} : { Method: [{ value: 'Experiment' }] },
          ...(reviewers > 1 ? { reviews: { '1': {}, '2': { Method: [{ value: 'Survey' }] } } } : {}),
        },
      ],
    }),
    null,
    'test.json',
  )
}

const nodeList = () => {
  const toggle = screen.getByRole('button', { name: /^Nodes \(/ })
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  return within(screen.getByRole('navigation', { name: 'Nodes' }).querySelector('ul') as HTMLElement)
}
const listed = () => nodeList().getAllByRole('button').map((b) => b.textContent)
const canvas = () => screen.getByRole('img')

/** jsdom has no canvas: this context records the calls of drawScene. */
function mockContext() {
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    setLineDash: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    rect: vi.fn(),
    arc: vi.fn(),
    fillText: vi.fn(),
  }
  return ctx
}
let ctx = mockContext()

const zoomLevel = () => ctx.setTransform.mock.lastCall![0] as number
const offset = () => ctx.setTransform.mock.lastCall!.slice(4) as number[]

/** Screen position of the last drawn node with this label. */
function drawn(label: string) {
  const [k, , , , x, y] = ctx.setTransform.mock.lastCall! as number[]
  const call = ctx.fillText.mock.calls.filter((c) => c[0] === label).at(-1)!
  return { clientX: (call[1] as number) * k + x, clientY: ((call[2] as number) + 12) * k + y }
}
configure({ asyncUtilTimeout: 5000 })

const waitForLabel = (label: string) => waitFor(() => expect(ctx.fillText.mock.calls.some((c) => c[0] === label)).toBe(true))

/** Submits a query without userEvent, which treats `{` and `[` as key names. */
function submit(text: string) {
  const box = screen.getByRole('textbox', { name: 'Graph query' })
  fireEvent.change(box, { target: { value: text } })
  fireEvent.submit(box.closest('form')!)
}

async function query(text: string) {
  const box = screen.getByRole('textbox', { name: 'Graph query' })
  await userEvent.clear(box)
  await userEvent.type(box, `${text}{Enter}`)
}

beforeEach(() => {
  saved.picks.length = saved.writes.length = 0
  useStore.setState({ project: null })
  ctx = mockContext()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as unknown as CanvasRenderingContext2D)
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('GraphView', () => {
  it('renders nothing without a project', () => {
    const { container } = render(<GraphView onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows every node in the canvas and in the accessible list', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    expect(listed()).toEqual(expect.arrayContaining(['Paper Graph Mining', 'Author Alan Turing', 'Choice Survey']))
    expect(canvas()).toHaveAccessibleName(/nodes, \d+ edges/)
    await waitForLabel('Alan Turing')
    expect(screen.getByRole('status')).toHaveTextContent(/nodes, \d+ edges/)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('filters to the sub-graph of a query and marks the matches', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    await query('author:alan')
    expect(listed().sort()).toEqual(['Author Alan Turing', 'Paper Testing Things'])
    expect(screen.getByRole('status')).toHaveTextContent('2 nodes, 1 edges')
    ctx.fillText.mockClear()
    await waitForLabel('Testing Things')
    expect(ctx.fillText.mock.calls.map((c) => c[0]).sort()).toEqual(['Alan Turing', 'Testing Things'])
    await query('type:venue')
    expect(screen.getByRole('status')).toHaveTextContent('No node matches the query.')
  })

  // [utest->req~ui-230~1]
  // [utest->req~ui-240~1]
  it('runs a Cypher query, lists its results and shows parse errors', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    const box = screen.getByRole('textbox', { name: 'Graph query' })
    const cypher = (text: string) => {
      fireEvent.change(box, { target: { value: text } })
      fireEvent.submit(box.closest('form')!)
    }
    cypher("match (p:Paper)-[:authoredBy]->(a:Author {label: 'Alan Turing'}) RETURN p.label AS title, a")
    const results = within(screen.getByRole('table'))
    expect(screen.getByRole('heading', { name: 'Results (1 rows)' })).toBeInTheDocument()
    expect(results.getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['title', 'a'])
    expect(results.getAllByRole('cell').map((c) => c.textContent)).toEqual(['Testing Things', 'Alan Turing'])
    expect(listed().sort()).toEqual(['Author Alan Turing', 'Paper Testing Things'])
    expect(screen.getByRole('status')).toHaveTextContent('2 nodes, 1 edges')

    cypher('MATCH (n) DETACH DELETE n')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Cypher query error: DETACH is not supported. Use a read-only query with MATCH, WHERE, RETURN and LIMIT.',
    )
    expect(listed().sort()).toEqual(['Author Alan Turing', 'Paper Testing Things'])
    cypher("MATCH (n) WHERE n.label = 'x")
    expect(screen.getByRole('alert')).toHaveTextContent('The quote at position 27 has no closing quote.')

    cypher('MATCH (a), (b), (c), (d), (e), (f) RETURN a, b, c, d, e, f')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Results (10000 rows)' })).toBeInTheDocument()
    expect(screen.getByText('The table shows the first 200 rows.')).toBeInTheDocument()
    expect(screen.getByText(/stopped at the limit of 10000 rows/)).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(201)

    await query('author:alan')
    expect(screen.queryByRole('table')).toBeNull()
    expect(listed().sort()).toEqual(['Author Alan Turing', 'Paper Testing Things'])
  })

  // [utest->req~ui-250~1]
  it('runs Cypher queries in a worker, sends the graph once and ends superseded queries', () => {
    FakeWorker.cypher = []
    vi.stubGlobal('Worker', FakeWorker)
    open()
    const { unmount } = render(<GraphView onClose={() => {}} />)
    const running = () => expect(screen.getByRole('status')).toHaveTextContent('Running the query…')
    submit('MATCH (a:Author) RETURN a.label')
    running()
    expect(screen.queryByRole('table')).toBeNull()
    const [first] = FakeWorker.cypher
    expect(first.sent.map((m) => m.type)).toEqual(['graph', 'query'])

    // A new query ends the running one; the view stays usable meanwhile.
    submit('MATCH (a)-[*3]-(b) RETURN count(*)')
    expect(first.terminate).toHaveBeenCalled()
    const second = FakeWorker.cypher[1]
    expect(second.sent.map((m) => m.type)).toEqual(['graph', 'query'])
    first.flush()
    running()
    expect(screen.queryByRole('table')).toBeNull()
    second.flush()
    expect(screen.getByRole('heading', { name: 'Results (1 rows)' })).toBeInTheDocument()

    submit('MATCH (p:Paper) RETURN p.label')
    second.flush()
    expect(screen.getByRole('heading', { name: 'Results (2 rows)' })).toBeInTheDocument()
    expect(second.sent.map((m) => m.type)).toEqual(['graph', 'query', 'query'])
    expect(FakeWorker.cypher).toHaveLength(2)

    // A text query cancels a running Cypher query.
    submit('MATCH (a:Author) RETURN a')
    submit('author:alan')
    expect(second.terminate).toHaveBeenCalled()
    expect(screen.queryByRole('table')).toBeNull()
    expect(listed().sort()).toEqual(['Author Alan Turing', 'Paper Testing Things'])

    submit('MATCH (n) RETURN n')
    unmount()
    expect(FakeWorker.cypher[2].terminate).toHaveBeenCalled()
  })

  // [utest->req~ui-250~1]
  it('stops a hung or failed Cypher worker and shows an error', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      FakeWorker.cypher = []
      vi.stubGlobal('Worker', FakeWorker)
      open()
      render(<GraphView onClose={() => {}} />)
      submit('MATCH (n) RETURN n')
      act(() => vi.advanceTimersByTime(CYPHER_TIMEOUT_MS - 1))
      expect(screen.getByRole('status')).toHaveTextContent('Running the query…')
      expect(screen.queryByRole('alert')).toBeNull()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByRole('alert')).toHaveTextContent(
        `Cypher query error: The query took longer than ${CYPHER_TIMEOUT_MS / 1000} seconds and was stopped.`,
      )
      expect(FakeWorker.cypher[0].terminate).toHaveBeenCalled()
      expect(screen.getByRole('status')).not.toHaveTextContent('Running')
      FakeWorker.cypher[0].flush()
      expect(screen.queryByRole('table')).toBeNull()

      submit('MATCH (n) RETURN n')
      expect(screen.queryByRole('alert')).toBeNull()
      act(() => FakeWorker.cypher[1].onerror!({ message: 'boom' }))
      expect(screen.getByRole('alert')).toHaveTextContent('Cypher query error: The query could not run: boom')
      expect(FakeWorker.cypher[1].terminate).toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(CYPHER_TIMEOUT_MS))
      expect(screen.getByRole('alert')).toHaveTextContent('boom')
    } finally {
      vi.useRealTimers()
    }
  })

  // [utest->req~ui-220~1]
  it('reads the relation colours again when the theme changes', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    await waitForLabel('Alan Turing')
    const style = vi.spyOn(window, 'getComputedStyle')
    act(() => useStore.getState().setTheme('dark'))
    await waitFor(() => expect(style.mock.calls.some(([el]) => el === canvas())).toBe(true))
    act(() => useStore.getState().setTheme('light'))
  })

  it('shows details and neighbours of a selected node and expands them', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    await query('author:alan depth:0')
    expect(listed()).toEqual(['Author Alan Turing'])
    await userEvent.click(nodeList().getByRole('button', { name: /Alan Turing/ }))
    expect(screen.getByRole('heading', { name: 'Alan Turing' })).toBeInTheDocument()
    expect(nodeList().getByRole('button', { name: /Alan Turing/ })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Show neighbours' }))
    expect(listed()).toEqual(expect.arrayContaining(['Author Alan Turing', 'Paper Testing Things']))
    const neighbourList = within(screen.getByRole('heading', { name: 'Neighbours' }).nextElementSibling as HTMLElement)
    await userEvent.click(neighbourList.getByRole('button', { name: /Testing Things/ }))
    expect(screen.getByRole('heading', { name: 'Testing Things' })).toBeInTheDocument()
  })

  it('selects a node on click, names it on hover and reveals its neighbours on double-click', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    await query('author:alan depth:0')
    ctx.fillText.mockClear()
    await waitForLabel('Alan Turing')
    const at = drawn('Alan Turing')
    fireEvent.pointerMove(canvas(), at)
    expect(canvas()).toHaveAttribute('title', 'Author: Alan Turing')
    fireEvent.pointerMove(canvas(), { clientX: 1, clientY: 1 })
    expect(canvas()).toHaveAttribute('title', '')
    fireEvent.pointerDown(canvas(), at)
    fireEvent.pointerUp(canvas(), at)
    expect(screen.getByRole('heading', { name: 'Alan Turing' })).toBeInTheDocument()
    fireEvent.doubleClick(canvas(), at)
    expect(listed()).toContain('Paper Testing Things')
    fireEvent.doubleClick(canvas(), { clientX: 1, clientY: 1 })
    expect(listed()).toHaveLength(2)
  })

  // [utest->req~ui-220~1]
  it('names an edge on hover and hides an edge type with its legend toggle', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    await query('author:alan')
    ctx.fillText.mockClear()
    await waitForLabel('Testing Things')
    await waitForLabel('Alan Turing')
    const hover = () => {
      const a = drawn('Testing Things')
      const b = drawn('Alan Turing')
      fireEvent.pointerMove(canvas(), { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 })
    }
    await waitFor(() => {
      hover()
      expect(canvas()).toHaveAttribute('title', 'authored by: Testing Things → Alan Turing')
    })
    const toggle = within(screen.getByRole('group', { name: 'Relations:' })).getByRole('checkbox', { name: 'authored by' })
    await userEvent.click(toggle)
    expect(toggle).not.toBeChecked()
    hover()
    expect(canvas()).toHaveAttribute('title', '')
  })

  it('pans the canvas, zooms, resets the view and drags a node', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    await waitForLabel('Alan Turing')
    expect(zoomLevel()).toBe(1)
    const [x0, y0] = offset()
    fireEvent.pointerDown(canvas(), { clientX: 1, clientY: 1 })
    fireEvent.pointerMove(canvas(), { clientX: 2, clientY: 2 })
    fireEvent.pointerMove(canvas(), { clientX: 31, clientY: 41 })
    fireEvent.pointerUp(canvas())
    await waitFor(() => expect(offset()).toEqual([x0 + 30, y0 + 40]))
    expect(screen.getByText(/^Select a node in the graph/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await waitFor(() => expect(zoomLevel()).toBe(1.25))
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    await waitFor(() => expect(zoomLevel()).toBe(1))
    fireEvent.wheel(canvas(), { deltaY: -100, clientX: 0, clientY: 0 })
    await waitFor(() => expect(zoomLevel()).toBeCloseTo(Math.exp(0.2)))
    ctx.fillText.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Reset view' }))
    await waitFor(() => expect(zoomLevel()).toBeLessThanOrEqual(1))
    await waitForLabel('Alan Turing')
    const at = drawn('Alan Turing')
    fireEvent.pointerDown(canvas(), at)
    fireEvent.pointerMove(canvas(), { clientX: at.clientX + 50, clientY: at.clientY + 50 })
    await waitFor(() => expect(drawn('Alan Turing').clientX).toBeCloseTo(at.clientX + 50, 0))
    fireEvent.pointerUp(canvas())
    expect(screen.queryByRole('heading', { name: 'Alan Turing' })).toBeNull()
  })

  it('pages the node list of a big graph', async () => {
    useStore.getState().loadFromText(
      JSON.stringify({
        version: 1,
        config: { schema: [{ name: 'Method', type: 'string' }], reviewers: 1 },
        papers: Array.from({ length: 210 }, (_, i) => ({ id: `p${i}`, title: `Paper ${i}`, authors: [], pdf: `${i}.pdf`, annotations: {} })),
      }),
      null,
      'big.json',
    )
    render(<GraphView onClose={() => {}} />)
    expect(listed()).toHaveLength(200)
    await userEvent.click(screen.getByRole('button', { name: 'Show more (200 of 210 listed)' }))
    expect(listed()).toHaveLength(210)
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull()
  })

  it('runs the layout in a worker and ends it on close', async () => {
    const workers: { terminate: () => void }[] = []
    vi.stubGlobal(
      'Worker',
      class {
        onmessage: ((e: { data: unknown }) => void) | null = null
        postMessage = layoutHost((data) => this.onmessage?.({ data }))
        terminate = vi.fn()
        constructor() {
          workers.push(this)
        }
      },
    )
    open()
    const { unmount } = render(<GraphView onClose={() => {}} />)
    await waitForLabel('Alan Turing')
    expect(workers).toHaveLength(1)
    unmount()
    expect(workers[0].terminate).toHaveBeenCalled()
  })

  it('switches the seat when answers are not consolidated', async () => {
    open(2)
    render(<GraphView onClose={() => {}} />)
    expect(listed()).not.toContain('Choice Survey')
    expect(screen.queryByRole('option', { name: 'Consolidation' })).toBeNull()
    await userEvent.selectOptions(screen.getByRole('combobox'), '2')
    expect(listed()).toContain('Choice Survey')
  })

  it('offers the consolidation as a seat once one is saved', async () => {
    open(2)
    useStore.setState((s) => {
      s.project!.papers[0].annotations = { Method: [{ value: 'Experiment' }] }
    })
    render(<GraphView onClose={() => {}} />)
    const seat = screen.getByRole('combobox')
    expect(seat).toHaveValue('consolidation')
    await userEvent.selectOptions(seat, '2')
    expect(listed()).toContain('Choice Survey')
  })

  // [utest->req~ui-400~1]
  it('saves the graph as an SVG of the whole graph from the download button', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    await waitForLabel('Alan Turing')
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))
    await userEvent.click(screen.getByRole('radio', { name: /^Whole graph/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(saved.writes).toHaveLength(1))
    expect(saved.picks[0]).toEqual(['knowledge-graph.svg', 'svg'])
    expect(saved.writes[0][0]).toBe('/out/graph')
    expect(String(saved.writes[0][1])).toMatch(/^<svg /)
  })

  it('opens the existing export dialog and closes with Escape', async () => {
    open()
    const onClose = vi.fn()
    render(<GraphView onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Export…' }))
    expect(screen.getByRole('dialog', { name: 'Export knowledge graph' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Export knowledge graph' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('node list drawer', () => {
  it('is folded by default and toggles open', () => {
    open()
    render(<GraphView onClose={() => {}} />)
    expect(screen.queryByRole('navigation', { name: 'Nodes' })).toBeNull()
    const toggle = screen.getByRole('button', { name: /^Nodes \(/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('navigation', { name: 'Nodes' })).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('graph shortcuts', () => {
  // [utest->req~ui-350~1]
  it('opens the selected paper in the annotation view and closes the graph', async () => {
    open()
    const onClose = vi.fn()
    render(<GraphView onClose={onClose} />)
    fireEvent.click(nodeList().getByRole('button', { name: /Testing Things/ }))
    expect(screen.queryByRole('button', { name: 'Open paper' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open paper' }))
    expect(useStore.getState().currentPaperId).toBe('p2')
    expect(onClose).toHaveBeenCalled()
  })

  // [utest->req~ui-350~1]
  it('offers no paper button for other nodes', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    fireEvent.click(nodeList().getByRole('button', { name: /Alan Turing/ }))
    expect(screen.queryByRole('button', { name: 'Open paper' })).toBeNull()
  })

  // [utest->req~ui-350~1]
  it('saves the Cypher result table as CSV', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    const box = screen.getByRole('textbox', { name: 'Graph query' })
    fireEvent.change(box, { target: { value: "match (p:Paper)-[:authoredBy]->(a:Author {label: 'Alan Turing'}) RETURN p.label AS title, a" } })
    fireEvent.submit(box.closest('form')!)
    fireEvent.click(screen.getByRole('button', { name: 'Save table as CSV' }))
    await waitFor(() => expect(saved.writes).toHaveLength(1))
    expect(saved.picks[0]).toEqual(['cypher-results.csv', 'csv'])
    expect(saved.writes[0][1]).toBe('"title","a"\r\n"Testing Things","Alan Turing"\r\n')
  })
})

describe('query box', () => {
  // [utest->req~ui-400~1]
  it('names the language, completes with Tab, and shows a Cypher error while typing', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    const box = screen.getByRole('textbox', { name: 'Graph query' }) as HTMLTextAreaElement
    expect(screen.getByText('Text')).toBeInTheDocument()
    await userEvent.type(box, 'MATCH (p:Pa')
    expect(screen.getByText('Cypher')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Paper' })).toBeInTheDocument()
    await userEvent.keyboard('{Tab}')
    expect(box.value).toBe('MATCH (p:Paper')
    fireEvent.change(box, { target: { value: 'MATCH (p:Paper) RETURN q' } })
    expect(screen.getByText(/Unknown variable q/)).toBeInTheDocument()
    expect(box).toHaveAttribute('aria-invalid', 'true')
  })

  // [utest->req~ui-400~1]
  it('submits on Enter and keeps a new line on Shift+Enter', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    const box = screen.getByRole('textbox', { name: 'Graph query' }) as HTMLTextAreaElement
    await userEvent.type(box, 'type:paper{Shift>}{Enter}{/Shift}depth:0')
    expect(box.value).toBe('type:paper\ndepth:0')
    await userEvent.type(box, '{Enter}')
    expect(box.value).toBe('type:paper\ndepth:0')
    expect(screen.getByText(/\d+ nodes?/)).toBeInTheDocument()
  })
})

describe('query help', () => {
  // [utest->req~ui-400~1]
  it('opens from the ? button with examples and closes on Escape without closing the view', async () => {
    open()
    const onClose = vi.fn()
    render(<GraphView onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Query help' }))
    const dialog = screen.getByRole('dialog', { name: 'How to search the graph' })
    expect(within(dialog).getByText('Method=Survey')).toBeInTheDocument()
    expect(within(dialog).getByText('MATCH (p:Paper) RETURN p.year AS year, count(*)')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'How to search the graph' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('node types and statistics', () => {
  // [utest->req~ui-390~1]
  it('hides the nodes of an unticked type from the graph and the list', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    const before = screen.getByRole('status', { name: '' }).textContent
    expect(nodeList().queryByRole('button', { name: /Alan Turing/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Author' }))
    expect(nodeList().queryByRole('button', { name: /Alan Turing/ })).toBeNull()
    expect(nodeList().queryByRole('button', { name: /Testing Things/ })).toBeInTheDocument()
    expect(screen.getAllByRole('status').some((s) => s.textContent !== before)).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Author' }))
    expect(nodeList().queryByRole('button', { name: /Alan Turing/ })).toBeInTheDocument()
  })

  // [utest->req~ui-360~1]
  it('shows statistics of the shown graph and jumps to a best connected node', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    fireEvent.click(screen.getByText('Statistics'))
    await screen.findByText('Connected groups')
    const stats = within(document.querySelector('.graph-stats') as HTMLElement)
    expect(stats.getByText('Best connected')).toBeInTheDocument()
    fireEvent.click(stats.getAllByRole('button')[0])
    expect(document.querySelector('#graph-detail-title')).not.toBeNull()
  })
})
