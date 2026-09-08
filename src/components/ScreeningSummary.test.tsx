import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useStore } from '../state/store'
import { ScreeningSummary } from './ScreeningSummary'

const st = () => useStore.getState()

function tree(decision?: string, reason?: string) {
  const t: Record<string, unknown> = {}
  if (decision) t.Decision = [{ value: decision }]
  if (reason) t.Reason = [{ value: reason }]
  return t
}

function screeningProjectJson() {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: { screening: { reasons: ['Wrong topic', 'Duplicate'] } },
    papers: [
      { id: 'p1', title: 'Included Paper', authors: [], pdf: '', annotations: tree('Include') },
      { id: 'p2', title: 'Excluded Duplicate', authors: [], pdf: '', annotations: tree('Exclude', 'Duplicate') },
      { id: 'p3', title: 'Excluded Unlisted', authors: [], pdf: '', annotations: tree('Exclude', 'Some other reason') },
      { id: 'p4', title: 'Undecided Paper', authors: [], pdf: '', annotations: {} },
    ],
  })
}

beforeEach(() => {
  useStore.setState({ project: null, screeningSummaryOpen: false })
})

describe('ScreeningSummary: counts and reason breakdown', () => {
  it('shows total/included/excluded/undecided and the per-reason table', () => {
    st().loadFromText(screeningProjectJson(), null, 'test.json')
    st().setScreeningSummaryOpen(true)
    render(<ScreeningSummary />)

    const headline = screen.getByText('total').closest('div')!
    expect(headline).toHaveTextContent('4')
    expect(screen.getByText('included').closest('div')).toHaveTextContent('1')
    expect(screen.getByText('excluded').closest('div')).toHaveTextContent('2')
    expect(screen.getByText('undecided').closest('div')).toHaveTextContent('1')

    // Configured reasons are listed even at zero, plus the unknown bucket.
    expect(screen.getByRole('row', { name: /Wrong topic 0/ })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /Duplicate 1/ })).toBeInTheDocument()
    expect(screen.getByText('No reason recorded / not one of the configured reasons').closest('tr')).toHaveTextContent(
      '1',
    )
  })

  it('renders nothing when the modal is closed', () => {
    st().loadFromText(screeningProjectJson(), null, 'test.json')
    render(<ScreeningSummary />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
