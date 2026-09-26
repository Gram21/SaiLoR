import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

/**
 * A seat is not a person. Large reviews keep a fixed number of readings per
 * paper (usually two) and divide the papers among many more people than that —
 * six reviewers over sixty papers, twenty each, on seat 1 or seat 2 as it
 * falls out. So the only collision worth warning about is per paper: somebody
 * has already read *this* paper in *this* seat.
 *
 * These tests exist mostly to pin the negatives. A project-wide "who owns seat
 * 1" warning would fire on nearly every paper a reviewer is legitimately
 * supposed to be doing, and a guard that wrong teaches people to ignore it.
 */
const mockPlatform = {
  kind: 'browser' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  getGit: () => null,
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('../state/store')
const { useGitStore } = await import('../state/gitStore')
const { SeatConflictNotice } = await import('./SeatConflictNotice')

const ANNA = { name: 'Anna Schmidt', email: 'anna@example.org' }
const AXEL = { name: 'Axel Braun', email: 'axel@example.org' }

const PROJECT = JSON.stringify({
  version: 1,
  config: { schema: [{ name: 'Relevant', type: 'boolean' }], reviewers: 2 },
  papers: [
    { id: 'p1', title: 'Paper One', authors: [], pdf: 'a.pdf' },
    { id: 'p2', title: 'Paper Two', authors: [], pdf: 'b.pdf' },
  ],
})

/** What `gitStore.refreshSeatOwners` fills in from `git log` in the real app. */
function authoredBy(files: Record<string, typeof ANNA>) {
  useGitStore.setState({ annotationAuthors: { me: ANNA, files } })
}

beforeEach(() => {
  useStore.getState().loadFromText(PROJECT, { kind: 'electron', path: '/x.json' }, 'x.json')
  useStore.getState().selectPaper('p1')
  useStore.setState({ currentReviewer: '1' })
  useGitStore.setState({ annotationAuthors: null })
})

describe('SeatConflictNotice', () => {
  it('warns when somebody else already read this paper in this seat', () => {
    authoredBy({ 'p1/reviewer-1.json': AXEL })
    render(<SeatConflictNotice />)
    expect(screen.getByRole('status')).toHaveTextContent('Axel Braun')
    expect(screen.getByRole('status')).toHaveTextContent('Reviewer 1')
  })

  it('stays silent on the other seat of the very same paper', () => {
    // Seat 2 of p1 is somebody else's job by design — that is the whole point
    // of two independent readings.
    authoredBy({ 'p1/reviewer-1.json': AXEL })
    useStore.setState({ currentReviewer: '2' })
    render(<SeatConflictNotice />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('stays silent on a different paper in the same seat', () => {
    // The case a project-wide warning would have got wrong: Axel holding seat
    // 1 on p1 says nothing about whose seat 1 is on p2.
    authoredBy({ 'p1/reviewer-1.json': AXEL })
    useStore.getState().selectPaper('p2')
    render(<SeatConflictNotice />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('stays silent about your own earlier work', () => {
    authoredBy({ 'p1/reviewer-1.json': ANNA })
    render(<SeatConflictNotice />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('stays silent outside a git repository', () => {
    render(<SeatConflictNotice />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
