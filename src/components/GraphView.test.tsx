// [utest->req~ui-190~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
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
const svgNode = (label: string) => screen.getByText(label, { selector: 'svg text' }).closest('g')!

async function query(text: string) {
  const box = screen.getByRole('searchbox', { name: 'Graph query' })
  await userEvent.clear(box)
  await userEvent.type(box, `${text}{Enter}`)
}

beforeEach(() => {
  useStore.setState({ project: null })
})

describe('GraphView', () => {
  it('renders nothing without a project', () => {
    const { container } = render(<GraphView onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows every node in the canvas and in the accessible list', () => {
    open()
    render(<GraphView onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Knowledge graph' })).toBeInTheDocument()
    expect(listed()).toEqual(expect.arrayContaining(['Paper Graph Mining', 'Author Alan Turing', 'Choice Survey']))
    expect(svgNode('Alan Turing')).toHaveClass('graph-node', 'graph-node-author')
    expect(screen.getByRole('status')).toHaveTextContent(/nodes, \d+ edges/)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('filters to the sub-graph of a query and marks the matches', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    await query('author:alan')
    expect(listed().sort()).toEqual(['Author Alan Turing', 'Paper Testing Things'])
    expect(screen.getByRole('status')).toHaveTextContent('2 nodes, 1 edges')
    expect(svgNode('Alan Turing')).toHaveClass('is-match')
    expect(svgNode('Testing Things')).not.toHaveClass('is-match')
    await query('type:venue')
    expect(screen.getByRole('status')).toHaveTextContent('No node matches the query.')
  })

  it('shows details and neighbours of a selected node and expands them', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    await query('author:alan depth:0')
    expect(listed()).toEqual(['Author Alan Turing'])
    await userEvent.click(nodeList().getByRole('button', { name: /Alan Turing/ }))
    expect(screen.getByRole('heading', { name: 'Alan Turing' })).toBeInTheDocument()
    expect(nodeList().getByRole('button', { name: /Alan Turing/ })).toHaveAttribute('aria-pressed', 'true')
    expect(svgNode('Alan Turing')).toHaveClass('is-selected')
    await userEvent.click(screen.getByRole('button', { name: 'Show neighbours' }))
    expect(listed()).toEqual(expect.arrayContaining(['Author Alan Turing', 'Paper Testing Things']))
    const neighbourList = within(screen.getByRole('heading', { name: 'Neighbours' }).nextElementSibling as HTMLElement)
    await userEvent.click(neighbourList.getByRole('button', { name: /Testing Things/ }))
    expect(screen.getByRole('heading', { name: 'Testing Things' })).toBeInTheDocument()
  })

  it('selects a node on click and reveals its neighbours on double-click in the canvas', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    await query('author:alan depth:0')
    const g = svgNode('Alan Turing')
    fireEvent.pointerDown(g, { clientX: 5, clientY: 5 })
    fireEvent.pointerUp(g)
    expect(screen.getByRole('heading', { name: 'Alan Turing' })).toBeInTheDocument()
    fireEvent.doubleClick(svgNode('Alan Turing'))
    expect(listed()).toContain('Paper Testing Things')
  })

  it('drags a node, pans the canvas and zooms', async () => {
    open()
    render(<GraphView onClose={() => {}} />)
    const svg = screen.getByRole('img')
    const layer = () => svg.firstElementChild!.getAttribute('transform')
    const before = layer()
    fireEvent.pointerDown(svg, { clientX: 0, clientY: 0 })
    fireEvent.pointerMove(svg, { clientX: 1, clientY: 1 })
    expect(layer()).toBe(before)
    fireEvent.pointerMove(svg, { clientX: 30, clientY: 40 })
    fireEvent.pointerUp(svg)
    expect(layer()).toBe('translate(30,40) scale(1)')
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(layer()).toContain('scale(1.25)')
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    fireEvent.wheel(svg, { deltaY: -100, clientX: 0, clientY: 0 })
    expect(layer()).not.toContain('scale(1)')
    await userEvent.click(screen.getByRole('button', { name: 'Reset view' }))
    expect(layer()).toBe('translate(0,0) scale(1)')

    const g = svgNode('Alan Turing')
    fireEvent.pointerDown(g, { clientX: 0, clientY: 0 })
    fireEvent.pointerMove(svg, { clientX: 50, clientY: 50 })
    fireEvent.pointerUp(svg)
    expect(screen.queryByRole('heading', { name: 'Alan Turing' })).toBeNull()
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
