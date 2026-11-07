// [utest->req~dat-520~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const picks: [string, string | undefined][] = []
const writes: [string, string][] = []
let pickResult: string | null = '/out/file'
let cancelPick = 0

vi.mock('../platform', () => ({
  getPlatform: () => ({
    kind: 'electron',
    getRecents: () => [],
    rememberProject: () => {},
    forgetRecent: () => [],
    checkRecents: async (e: unknown[]) => e,
    getOsInfo: () => null,
    pickTextExportPath: async (name: string, ext?: string) => {
      picks.push([name, ext])
      return pickResult && picks.length !== cancelPick ? `${pickResult}-${picks.length}.${ext}` : null
    },
    writeTextFile: async (path: string, text: string) => {
      writes.push([path, text])
      return { ok: true, path }
    },
  }),
}))

const { useStore } = await import('../state/store')
const { ExportGraphDialog } = await import('./ExportGraphDialog')

function open(reviewers: number, consolidated: boolean) {
  useStore.getState().loadFromText(
    JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'Method', type: 'string', options: ['Survey', 'Experiment'] }], reviewers },
      papers: [
        {
          id: 'p1',
          title: 'A Paper',
          authors: ['Jane Doe'],
          pdf: 'a.pdf',
          annotations: consolidated ? { Method: [{ value: 'Survey' }] } : {},
          ...(reviewers > 1 ? { reviews: { '1': {}, '2': { Method: [{ value: 'Experiment' }] } } } : {}),
        },
      ],
    }),
    null,
    'test.json',
  )
}

beforeEach(() => {
  picks.length = 0
  writes.length = 0
  pickResult = '/out/file'
  cancelPick = 0
  useStore.setState({ project: null })
})

describe('ExportGraphDialog', () => {
  it('saves Turtle through the export dialog with the .ttl extension', async () => {
    open(1, true)
    render(<ExportGraphDialog onClose={() => {}} />)
    expect(screen.queryByRole('combobox')).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: 'RDF Turtle (.ttl)' }))
    await userEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(picks).toEqual([['knowledge-graph.ttl', 'ttl']])
    expect(writes[0][1]).toContain('<urn:sailor:paper:p1> a schema:ScholarlyArticle')
    expect(await screen.findByText('Saved to /out/file-1.ttl')).toBeInTheDocument()
  })

  it('asks for the node file and then the edge file for CSV', async () => {
    open(1, true)
    render(<ExportGraphDialog onClose={() => {}} />)
    await userEvent.click(screen.getByRole('radio', { name: 'CSV node and edge lists (.csv)' }))
    await userEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(picks).toEqual([
      ['knowledge-graph-nodes.csv', 'csv'],
      ['knowledge-graph-edges.csv', 'csv'],
    ])
    expect(writes[0][1].split('\r\n')[0]).toMatch(/^"id","type","label"/)
    expect(writes[1][1].split('\r\n')[0]).toBe('"source","target","type","field"')
  })

  it('reports an incomplete CSV export when the edge file dialog is cancelled', async () => {
    open(1, true)
    cancelPick = 2
    render(<ExportGraphDialog onClose={() => {}} />)
    await userEvent.click(screen.getByRole('radio', { name: 'CSV node and edge lists (.csv)' }))
    await userEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(writes).toHaveLength(1)
    expect(await screen.findByText('Saved to /out/file-1.csv')).toBeInTheDocument()
    expect(
      screen.getByText('knowledge-graph-edges.csv was not saved. The export is incomplete.'),
    ).toHaveClass('ai-error')
  })

  it('exports the selected seat when no consolidated answer exists', async () => {
    open(2, false)
    render(<ExportGraphDialog onClose={() => {}} />)
    await userEvent.selectOptions(screen.getByRole('combobox'), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(writes[0][1]).toContain('urn:sailor:choice:Method%3DExperiment')
  })

  it('selects the consolidation by default once saved and writes nothing when the save dialog is cancelled', async () => {
    open(2, true)
    pickResult = null
    render(<ExportGraphDialog onClose={() => {}} />)
    expect(screen.getByRole('combobox', { name: 'Seat' })).toHaveValue('consolidation')
    await userEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(picks).toHaveLength(1)
    expect(writes).toHaveLength(0)
  })
})
