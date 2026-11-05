// [utest->req~llm-830~1]
// [utest->req~llm-831~1]
// [utest->req~llm-832~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const writes: [string, string][] = []

vi.mock('../platform', () => ({
  getPlatform: () => ({
    kind: 'electron',
    getRecents: () => [],
    rememberProject: () => {},
    forgetRecent: () => [],
    checkRecents: async (e: unknown[]) => e,
    getOsInfo: () => null,
    pickTextExportPath: async (name: string) => `/out/${name}`,
    writeTextFile: async (path: string, text: string) => {
      writes.push([path, text])
      return { ok: true, path }
    },
  }),
}))

const { useStore } = await import('../state/store')
const { AiEvaluationDialog } = await import('./AiEvaluationDialog')

const USAGE = { provider: 'openai', model: 'gpt-5.5', appliedAt: '2026-11-05T00:00:00Z', reviewer: '2' }

function open({ aiSeat = true, consolidated = true } = {}) {
  useStore.getState().loadFromText(
    JSON.stringify({
      version: 1,
      config: {
        schema: [
          { name: 'Method', type: 'string' },
          { name: 'Venue', type: 'string' },
        ],
        reviewers: 2,
        ai: true,
        aiSeat,
      },
      papers: [
        {
          id: 'p1',
          title: 'Secret Paper Title',
          authors: ['Jane Doe'],
          pdf: 'a.pdf',
          annotations: consolidated ? { Method: [{ value: 'Survey' }], Venue: [{ value: 'ICSE' }] } : {},
          reviews: { '1': {}, '2': { Method: [{ value: 'Survey' }], Venue: [{ value: 'FSE' }] } },
          aiUsage: [USAGE],
        },
      ],
    }),
    null,
    'test.json',
  )
}

beforeEach(() => {
  writes.length = 0
  useStore.setState({ project: null })
})

describe('AiEvaluationDialog', () => {
  it('lists fields worst first with compared counts and agree percent', () => {
    open()
    render(<AiEvaluationDialog onClose={() => {}} />)
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.textContent)).toEqual(['Venue10 %', 'Method1100 %'])
    expect(screen.queryByText(/Secret Paper Title/)).toBeNull()
    expect(screen.queryByText(/FSE|ICSE|Survey/)).toBeNull()
  })

  it('exports the table as CSV without paper text and leaves the project unchanged', async () => {
    open()
    const before = useStore.getState().project
    render(<AiEvaluationDialog onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(writes).toEqual([
      [
        '/out/ai-evaluation.csv',
        [
          '"field","compared","equal","differ","ai_only","missed","agree_percent"',
          '"Venue","1","0","1","0","0","0"',
          '"Method","1","1","0","0","0","100"',
          '',
        ].join('\r\n'),
      ],
    ])
    expect(await screen.findByText('Saved to /out/ai-evaluation.csv')).toBeInTheDocument()
    expect(useStore.getState().project).toBe(before)
  })

  it('shows an empty state when nothing is consolidated yet', () => {
    open({ consolidated: false })
    render(<AiEvaluationDialog onClose={() => {}} />)
    expect(screen.getByText(/No field has an AI value and a consolidated value yet/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull()
  })

  it('shows an empty state when the project has no AI seat', () => {
    open({ aiSeat: false })
    render(<AiEvaluationDialog onClose={() => {}} />)
    expect(screen.getByText(/This project has no AI seat/)).toBeInTheDocument()
  })
})
