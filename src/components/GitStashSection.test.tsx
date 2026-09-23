import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * The stash list exists so parked work cannot go unnoticed — above all a
 * branch-switch carry-over that failed to come back, which used to leave no
 * trace in the UI at all. And deleting one destroys changes that are in no
 * file and no commit, so it must never happen on a single click.
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

const { useGitStore } = await import('../state/gitStore')
const { GitStashSection } = await import('./GitStashSection')

const stranded = {
  sha: 'a'.repeat(40),
  ref: 'stash@{0}',
  date: '2026-09-23T10:00:00Z',
  branch: 'main',
  message: 'sailor: switching branch',
  origin: 'branch-switch' as const,
}

let dropped: string[]
let restored: string[]

beforeEach(() => {
  dropped = []
  restored = []
  useGitStore.setState({
    stashes: [stranded],
    runStashDrop: async (sha: string) => {
      dropped.push(sha)
    },
    runStashRestore: async (sha: string) => {
      restored.push(sha)
    },
  })
})

describe('GitStashSection', () => {
  it('opens itself and says why a stranded carry-over exists', () => {
    render(<GitStashSection disabled={false} />)
    expect(screen.getByText(/Saved by SaiLoR while switching branches/)).toBeVisible()
    expect(screen.getByText(/Stashed changes \(1\)/)).toBeInTheDocument()
  })

  it('restores with one click', async () => {
    render(<GitStashSection disabled={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(restored).toEqual([stranded.sha])
  })

  it('asks before deleting, and keeps the stash on Cancel', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<GitStashSection disabled={false} />)
    await userEvent.click(screen.getByRole('button', { name: /Delete stash/ }))
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('gone for good'))
    expect(dropped).toEqual([])
    confirmSpy.mockRestore()
  })

  it('deletes once confirmed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<GitStashSection disabled={false} />)
    await userEvent.click(screen.getByRole('button', { name: /Delete stash/ }))
    expect(dropped).toEqual([stranded.sha])
    confirmSpy.mockRestore()
  })

  it('offers nothing to click while another git operation is running', () => {
    render(<GitStashSection disabled />)
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stash my changes' })).toBeDisabled()
  })
})
