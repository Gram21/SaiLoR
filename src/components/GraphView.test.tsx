// [utest->req~ui-190~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../platform', () => ({
  getPlatform: () => ({
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
const { GraphView } = await import('./GraphView')
const { layoutHost } = await import('../model/graphLayout')

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

const nodeList = () => within(screen.getByRole('heading', { name: 'Nodes' }).nextElementSibling as HTMLElement)
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
const waitForLabel = (label: string) => waitFor(() => expect(ctx.fillText.mock.calls.some((c) => c[0] === label)).toBe(true))

async function query(text: string) {
  const box = screen.getByRole('searchbox', { name: 'Graph query' })
  await userEvent.clear(box)
  await userEvent.type(box, `${text}{Enter}`)
}

beforeEach(() => {
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
    expect(screen.getByRole('dialog', { name: 'Knowledge graph' })).toBeInTheDocument()
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
    const box = screen.getByRole('searchbox', { name: 'Graph query' })
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
    await userEvent.selectOptions(screen.getByRole('combobox'), '2')
    expect(listed()).toContain('Choice Survey')
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
