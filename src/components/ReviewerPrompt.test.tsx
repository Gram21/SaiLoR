import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SeatOwners } from '../git/types'

/**
 * Two people both picking "Reviewer 1" write the same files, and whoever
 * merges last erases the other's answers. The picker's job is to make that
 * impossible to do without noticing: a seat somebody else has been committing
 * says so, and taking it needs a second click.
 */
let seatOwners: SeatOwners = { me: null, seats: {} }

const mockGit = {
  seatOwners: async () => seatOwners,
}

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  getGit: () => mockGit,
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('../state/store')
const { useGitStore } = await import('../state/gitStore')
const { ReviewerPrompt } = await import('./ReviewerPrompt')

const PROJECT = JSON.stringify({
  version: 1,
  config: { schema: [{ name: 'Relevant', type: 'boolean' }], reviewers: 2 },
  papers: [{ id: 'a', title: 'Paper A', authors: [], pdf: 'a.pdf' }],
})

const ANNA = { name: 'Anna Schmidt', email: 'anna@example.org' }
const AXEL = { name: 'Axel Braun', email: 'axel@example.org' }

beforeEach(() => {
  seatOwners = { me: null, seats: {} }
  useStore.getState().loadFromText(PROJECT, { kind: 'electron', path: '/x.json' }, 'x.json')
  useStore.setState({ currentReviewer: null })
  useGitStore.setState({
    repo: { root: '/repo', relPath: 'x.json', branch: 'main', upstream: null, hasHead: true },
  })
})

describe('ReviewerPrompt seat claims', () => {
  it('says nothing about holders when no seat has ever been committed', async () => {
    render(<ReviewerPrompt />)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    expect(screen.queryByText(/last committed by/)).not.toBeInTheDocument()
  })

  it('takes one click for a seat that is already yours', async () => {
    seatOwners = { me: ANNA, seats: { '1': ANNA, '2': null, consolidation: null } }
    render(<ReviewerPrompt />)
    await screen.findByText('last committed by you')

    await userEvent.click(screen.getByRole('button', { name: /Reviewer 1/ }))
    expect(useStore.getState().currentReviewer).toBe('1')
  })

  it('needs a second click to take a seat somebody else has been committing', async () => {
    seatOwners = { me: ANNA, seats: { '1': AXEL, '2': null, consolidation: null } }
    render(<ReviewerPrompt />)
    await screen.findByText('last committed by Axel Braun')

    await userEvent.click(screen.getByRole('button', { name: /Reviewer 1/ }))
    // Not taken — the click asked instead.
    expect(useStore.getState().currentReviewer).toBeNull()
    expect(screen.getByText('Take it from Axel Braun?')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Reviewer 1/ }))
    expect(useStore.getState().currentReviewer).toBe('1')
  })

  it('does not ask twice for a free seat sitting next to a taken one', async () => {
    seatOwners = { me: ANNA, seats: { '1': AXEL, '2': null, consolidation: null } }
    render(<ReviewerPrompt />)
    await screen.findByText('last committed by Axel Braun')

    await userEvent.click(screen.getByRole('button', { name: /Reviewer 2/ }))
    expect(useStore.getState().currentReviewer).toBe('2')
  })

  it('guards the Consolidation seat the same way', async () => {
    seatOwners = { me: ANNA, seats: { '1': null, '2': null, consolidation: AXEL } }
    render(<ReviewerPrompt />)
    await screen.findByText('last committed by Axel Braun')

    await userEvent.click(screen.getByRole('button', { name: /Consolidation/ }))
    expect(useStore.getState().currentReviewer).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /Consolidation/ }))
    expect(useStore.getState().currentReviewer).toBe('consolidation')
  })
})
