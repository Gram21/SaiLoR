// [utest->req~ui-280~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const saved = vi.hoisted(() => ({ picks: [] as unknown[][], writes: [] as unknown[][] }))

vi.mock('../platform', () => ({
  getPlatform: () => ({
    pickTextExportPath: async (...a: unknown[]) => (saved.picks.push(a), '/out/diagram.svg'),
    writeTextFile: async (...a: unknown[]) => (saved.writes.push(a), { ok: true, path: '/out/diagram.svg' }),
    kind: 'electron',
    getRecents: () => [],
    rememberProject: () => {},
    forgetRecent: () => [],
    checkRecents: async (e: unknown[]) => e,
    getOsInfo: () => null,
  }),
}))

const { useStore } = await import('../state/store')
const { ResultView } = await import('./ResultView')

function open() {
  useStore.getState().loadFromText(
    JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'Method', type: 'string', options: ['Survey', 'Experiment'] }], reviewers: 1 },
      papers: [
        { id: 'p1', title: 'One', authors: [], pdf: 'a.pdf', year: 2019, annotations: { Method: [{ value: 'Survey' }] } },
        { id: 'p2', title: 'Two', authors: [], pdf: 'b.pdf', year: 2020, annotations: { Method: [{ value: 'Experiment' }] } },
      ],
    }),
    null,
    'test.json',
  )
}

describe('ResultView diagrams', () => {
  beforeEach(() => globalThis.localStorage?.clear())

  // [utest->req~ui-270~1]
  it('switches between the knowledge graph and the diagrams', async () => {
    open()
    render(<ResultView initial="diagram" onClose={() => {}} />)
    expect(screen.getByRole('tab', { name: 'Diagrams' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByRole('tab', { name: 'Knowledge graph' }))
    expect(screen.getByRole('tab', { name: 'Knowledge graph' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('combobox', { name: /Count papers by/ })).not.toBeInTheDocument()
  })

  // [utest->req~ui-280~1]
  // [utest->req~ui-320~1]
  it('renders a live diagram from the title setting and saves it as SVG', async () => {
    open()
    render(<ResultView initial="diagram" onClose={() => {}} />)
    await userEvent.type(screen.getByRole('textbox', { name: /^Title/ }), 'My title')
    await waitFor(() => expect(document.querySelector('img.diagram-image')).toBeTruthy())
    await waitFor(() => expect(decodeURIComponent(String(document.querySelector('img.diagram-image')!.getAttribute('src')))).toContain('My title'))
    await userEvent.click(screen.getByRole('button', { name: /SVG/ }))
    await waitFor(() => expect(saved.writes).toHaveLength(1))
    expect(saved.picks[0][0]).toBe('diagram.svg')
    expect(String(saved.writes[0][1])).toContain('My title')
  })

  it('closes on Escape', async () => {
    open()
    const onClose = vi.fn()
    render(<ResultView initial="diagram" onClose={onClose} />)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  // [utest->req~ui-270~1]
  it('keeps the settings when the tab changes', async () => {
    open()
    render(<ResultView initial="diagram" onClose={() => {}} />)
    await userEvent.type(screen.getByRole('textbox', { name: /^Title/ }), 'Kept')
    await userEvent.click(screen.getByRole('tab', { name: 'Knowledge graph' }))
    await userEvent.click(screen.getByRole('tab', { name: 'Diagrams' }))
    expect(screen.getByRole('textbox', { name: /^Title/ })).toHaveValue('Kept')
  })

  // [utest->req~ui-330~1]
  it('filters the papers and changes the bar direction', async () => {
    open()
    render(<ResultView initial="diagram" onClose={() => {}} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Only papers where/ }), 'Method')
    await userEvent.type(screen.getByRole('textbox', { name: /Value contains/ }), 'survey')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 papers'))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Horizontal bars' }))
    await waitFor(() => expect(decodeURIComponent(String(document.querySelector('img.diagram-image')!.getAttribute('src')))).toContain('rotate(-90'))
    expect(screen.queryByRole('checkbox', { name: /shares of 100/ })).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: 'Stacked bar' }))
    expect(screen.getByRole('checkbox', { name: /shares of 100/ })).toBeInTheDocument()
  })

  // [utest->req~ui-340~1]
  it('shows the data as a table and saves it as CSV', async () => {
    open()
    saved.picks.length = saved.writes.length = 0
    render(<ResultView initial="diagram" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Show data table')).toBeInTheDocument())
    const table = within(screen.getByRole('table'))
    expect(table.getAllByRole('rowheader').map((c) => c.textContent)).toEqual(['2019', '2020'])
    await userEvent.click(screen.getByRole('button', { name: 'CSV' }))
    await waitFor(() => expect(saved.writes).toHaveLength(1))
    expect(saved.picks[0][0]).toBe('diagram.csv')
    expect(String(saved.writes[0][1])).toContain('"2019","1"')
  })
})
