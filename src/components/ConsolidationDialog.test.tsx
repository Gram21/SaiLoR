import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { ConsolidationDialog } from './ConsolidationDialog'

const st = () => useStore.getState()

function projectJson() {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: { schema: [{ name: 'Study Type', type: 'string' }], reviewers: 2 },
    papers: [
      {
        id: 'p1',
        title: 'A Paper',
        authors: [],
        pdf: 'a.pdf',
        annotations: {},
        reviews: {
          '1': { 'Study Type': [{ value: 'RCT' }] },
          '2': { 'Study Type': [{ value: 'Cohort' }] },
        },
      },
    ],
  })
}

function openOnStudyType() {
  st().loadFromText(projectJson(), null, 'test.json')
  st().selectPaper('p1')
  st().selectReviewer('consolidation')
  useStore.setState({ consolidationTarget: { path: [], name: 'Study Type', index: 0 } })
}

beforeEach(() => {
  useStore.setState({ project: null, consolidationTarget: null })
})

describe('ConsolidationDialog: side-by-side answer comparison (REQ-CON-340)', () => {
  it('shows both reviewers\' differing answers at once', () => {
    openOnStudyType()
    render(<ConsolidationDialog />)
    expect(screen.getByRole('button', { name: 'Reviewer 1 RCT' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reviewer 2 Cohort' })).toBeInTheDocument()
  })
})

describe('ConsolidationDialog: adopt a reviewer\'s answer (REQ-CON-350)', () => {
  it('clicking a reviewer\'s row writes their answer into the consolidated value', async () => {
    openOnStudyType()
    render(<ConsolidationDialog />)
    await userEvent.click(screen.getByRole('button', { name: 'Reviewer 1 RCT' }))
    expect(st().project!.papers[0].annotations['Study Type'][0].value).toBe('RCT')
    // The dialog closes after taking an answer.
    expect(st().consolidationTarget).toBeNull()
  })
})

describe('ConsolidationDialog: guard stranded equivalence marks (REQ-CON-370)', () => {
  it('blocks closing once marked equivalent with no value recorded, and offers to discard the mark', async () => {
    openOnStudyType()
    render(<ConsolidationDialog />)
    await userEvent.click(screen.getByLabelText('These answers mean the same thing'))
    // Attempt to leave via the close (×) button.
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('alert')).toHaveTextContent('This field would be left with no answer.')
    // The dialog is still open — it did not silently close.
    expect(st().consolidationTarget).not.toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Close and un-mark them' }))
    expect(st().consolidationTarget).toBeNull()
    expect(st().project!.papers[0].equal).not.toContain('Study Type')
  })

  it('does not warn once a value has been recorded under the equivalence mark', async () => {
    openOnStudyType()
    render(<ConsolidationDialog />)
    await userEvent.click(screen.getByLabelText('These answers mean the same thing'))
    await userEvent.click(screen.getByRole('button', { name: 'Reviewer 1 RCT' }))
    // Taking an answer closes the dialog directly, without a warning.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(st().consolidationTarget).toBeNull()
  })

  it('does not warn when the answers were never marked equivalent', async () => {
    openOnStudyType()
    render(<ConsolidationDialog />)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(st().consolidationTarget).toBeNull()
  })
})
