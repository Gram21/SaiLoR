import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/** REQ-EDT-70: record the review protocol (research questions, search
 *  strings, databases, search date, notes) into the draft's `protocol`. */
const mockPlatform = {
  kind: 'browser' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore } = await import('../state/editorStore')
const { ProtocolEditor } = await import('./ProtocolEditor')

beforeEach(() => {
  useEditorStore.setState({ protocol: null, past: [], future: [] })
})

describe('ProtocolEditor', () => {
  it('assembles a protocol from what is typed into each field', async () => {
    render(<ProtocolEditor />)

    await userEvent.type(
      screen.getByPlaceholderText(/RQ1: Which techniques/),
      'RQ1: What works?{Enter}RQ2: How well?',
    )
    await userEvent.type(
      screen.getByPlaceholderText('One per line — the query used against each database'),
      'title:(x AND y)',
    )
    await userEvent.type(screen.getByPlaceholderText(/Scopus/), 'Scopus{Enter}IEEE Xplore')
    await userEvent.type(screen.getByPlaceholderText(/2024-03/), '2024-03')
    await userEvent.type(
      screen.getByPlaceholderText(/The criteria a paper had to meet/),
      'English language only',
    )

    expect(useEditorStore.getState().protocol).toEqual({
      researchQuestions: ['RQ1: What works?', 'RQ2: How well?'],
      searchStrings: ['title:(x AND y)'],
      databases: ['Scopus', 'IEEE Xplore'],
      searchDate: '2024-03',
      notes: 'English language only',
    })
  })

  it('an all-blank protocol is stored as null rather than an empty object', async () => {
    render(<ProtocolEditor />)

    const rq = screen.getByPlaceholderText(/RQ1: Which techniques/)
    await userEvent.type(rq, '   ')
    await userEvent.clear(rq)

    expect(useEditorStore.getState().protocol).toBeNull()
  })

  it('shows an existing protocol already recorded on the draft', () => {
    useEditorStore.setState({
      protocol: {
        researchQuestions: ['RQ1: Existing question?'],
        databases: ['ACM Digital Library'],
      },
    })
    render(<ProtocolEditor />)

    expect(screen.getByDisplayValue('RQ1: Existing question?')).toBeInTheDocument()
    expect(screen.getByDisplayValue('ACM Digital Library')).toBeInTheDocument()
  })
})
