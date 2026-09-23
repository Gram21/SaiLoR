import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GitPlatform } from '../git/types'
import { useGitStore } from '../state/gitStore'
import { GitCloneDialog } from './GitCloneDialog'

// REQ-GIT-100: clone a project repository — this exercises GitCloneDialog +
// gitStore's clone/openClone/pickCloneParent/runClone actions against a
// mocked GitPlatform, the same seam electron/main.ts sits behind in
// production (out of scope here).

const clone = vi.fn<GitPlatform['clone']>()
const pickCloneDir = vi.fn<GitPlatform['pickCloneDir']>()

const fakeGit: GitPlatform = {
  probe: async () => ({ available: true, version: '', error: '' }),
  pickCloneDir,
  clone,
  pickProjectIn: async () => null,
  info: async () => null,
  status: async () => ({ changes: [], diff: '', diffTruncated: false }),
  commit: async () => ({ ok: false, code: null, stdout: '', stderr: 'unused' }),
  lastCommitMessage: async () => null,
  push: async () => ({ ok: false, code: null, stdout: '', stderr: 'unused' }),
  beginPull: async () => ({ kind: 'no-upstream', branch: null }),
  beginMerge: async () => ({ kind: 'up-to-date' }),
  logBegin: async () => ({ commits: [], truncated: false, error: null }),
  logDiff: async () => ({ kind: 'initial' }),
  finishPull: async () => ({ ok: false, code: null, stdout: '', stderr: 'unused' }),
  abortPull: async () => ({ ok: false, code: null, stdout: '', stderr: 'unused' }),
  headContent: async () => null,
  workingContent: async () => null,
  commitPartial: async () => ({ ok: false, code: null, stdout: '', stderr: 'unused' }),
  writeWorking: async () => ({ ok: false, code: null, stdout: '', stderr: 'unused' }),
  annotationAuthors: async () => ({ me: null, files: {} }),
  repoSetupStatus: async () => ({ upToDate: true, needsConsent: false, paths: [] }),
  applyRepoSetup: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
  backgroundFetch: async () => ({ fetched: false, refused: false }),
  stashList: async () => [],
  stashPush: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
  stashRestore: async () => ({ kind: 'restored' as const }),
  stashDrop: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
  stashBranch: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
  branches: async () => [],
  createBranch: async () => ({ ok: false, code: null, stdout: '', stderr: 'unused' }),
  deleteBranch: async () => ({ ok: false, code: null, stdout: '', stderr: 'unused' }),
  checkoutBranch: async () => ({ ok: false, code: null, stdout: '', stderr: 'unused' }),
  beginBranchSwitch: async () => ({ kind: 'error', message: 'unused' }),
  finishBranchSwitch: async () => ({ ok: false, code: null, stdout: '', stderr: 'unused' }),
  abortBranchSwitch: async () => ({ ok: false, code: null, stdout: '', stderr: 'unused' }),
  discardFile: async () => ({ ok: false, code: null, stdout: '', stderr: 'unused' }),
}

vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>()
  return { ...actual, getPlatform: () => ({ ...actual.getPlatform(), getGit: () => fakeGit }) }
})

beforeEach(() => {
  clone.mockReset()
  pickCloneDir.mockReset()
  useGitStore.setState({ clone: null })
})

describe('GitCloneDialog: clone a project repository', () => {
  it('clones with the URL typed and the folder picked, then shows the result', async () => {
    const user = userEvent.setup()
    pickCloneDir.mockResolvedValue('/home/reviewer/repos')
    clone.mockResolvedValue({ ok: true, dest: '/home/reviewer/repos/my-review' })

    useGitStore.getState().openClone()
    render(<GitCloneDialog />)

    await user.type(screen.getByLabelText('Repository URL'), 'https://github.com/org/my-review.git')
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await screen.findByText('/home/reviewer/repos')

    const cloneButton = screen.getByRole('button', { name: 'Clone' })
    expect(cloneButton).toBeEnabled()
    await user.click(cloneButton)

    expect(clone).toHaveBeenCalledWith(
      'https://github.com/org/my-review.git',
      '/home/reviewer/repos/my-review',
    )
    await screen.findByText('Cloned into /home/reviewer/repos/my-review.')
  })

  it('shows the reported error and lets the reviewer go back to setup', async () => {
    const user = userEvent.setup()
    pickCloneDir.mockResolvedValue('/home/reviewer/repos')
    clone.mockResolvedValue({ ok: false, error: 'fatal: repository not found' })

    useGitStore.getState().openClone()
    render(<GitCloneDialog />)

    await user.type(screen.getByLabelText('Repository URL'), 'https://github.com/org/missing.git')
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await screen.findByText('/home/reviewer/repos')
    await user.click(screen.getByRole('button', { name: 'Clone' }))

    await screen.findByText('fatal: repository not found')
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
  })
})
