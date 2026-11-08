// [utest->req~ui-280~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
})
