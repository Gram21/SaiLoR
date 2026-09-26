import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../platform', () => ({ getPlatform: () => ({ kind: 'browser', getRecents: () => [], getGit: () => null }) }))

const { useGitStore } = await import('../state/gitStore')
const { RepoSetupToast } = await import('./RepoSetupToast')

/**
 * The repository setup lands in a commit nobody typed, so it is announced —
 * but as a statement, not something to act on: a success goes by itself, and
 * only a failure waits to be read.
 */
describe('RepoSetupToast', () => {
  beforeEach(() => useGitStore.setState({ repoSetupNotice: null }))
  afterEach(() => vi.useRealTimers())

  it('says nothing when there is nothing to say', () => {
    render(<RepoSetupToast />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('announces a success and then goes by itself', () => {
    vi.useFakeTimers()
    useGitStore.setState({ repoSetupNotice: { kind: 'ok', text: 'Added rules.' } })
    render(<RepoSetupToast />)
    expect(screen.getByRole('status')).toHaveTextContent('Added rules.')
    act(() => vi.advanceTimersByTime(6000))
    expect(useGitStore.getState().repoSetupNotice).toBeNull()
  })

  it('keeps a failure up until it is closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    useGitStore.setState({ repoSetupNotice: { kind: 'error', text: 'Could not configure.' } })
    render(<RepoSetupToast />)
    act(() => vi.advanceTimersByTime(60000))
    expect(screen.getByRole('status')).toHaveTextContent('Could not configure.')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(useGitStore.getState().repoSetupNotice).toBeNull()
  })
})
