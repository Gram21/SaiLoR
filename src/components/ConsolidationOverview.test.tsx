// [utest->req~llm-830~1]
// [utest->req~ui-170~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

const { useStore } = await import('../state/store')
const { ConsolidationOverview } = await import('./ConsolidationOverview')

function open(ai: boolean) {
  useStore.getState().loadFromText(
    JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'Method', type: 'string' }], reviewers: 2, ai, aiSeat: ai },
      papers: [{ id: 'p1', title: 'One', pdf: 'a.pdf', annotations: {}, reviews: { '1': {}, '2': {} } }],
    }),
    null,
    'test.json',
  )
  useStore.getState().setConsolidationOverviewOpen(true)
}

describe('AI evaluation in the Consolidation overview', () => {
  it('opens the AI evaluation dialog when AI is on', async () => {
    open(true)
    render(<ConsolidationOverview />)
    await userEvent.click(screen.getByRole('button', { name: 'AI evaluation' }))
    expect(screen.getByRole('dialog', { name: 'AI evaluation' })).toBeInTheDocument()
  })

  it('has no AI evaluation button when AI is off', () => {
    open(false)
    render(<ConsolidationOverview />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'AI evaluation' })).not.toBeInTheDocument()
  })
})
