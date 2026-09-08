import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useGitStore } from '../state/gitStore'
import { useStore } from '../state/store'
import { GitDialog } from './GitDialog'

// REQ-GIT-190: protect project files from whole-file discard. electron/main.ts's
// server-side refusal is out of scope — this only checks the renderer half:
// GitDialog withholds the per-file discard control for the project's own
// tracked path (and its annotations/ tree), via `isProjectOwnPath`, while an
// ordinary changed file keeps a working one.

beforeEach(() => {
  useStore.setState({ dirty: false })
  useGitStore.setState({
    repo: { root: '/repo', relPath: 'review.json', branch: 'main', upstream: null, hasHead: true },
    panel: {
      phase: 'idle',
      status: {
        changes: [
          { path: 'review.json', code: 'M ', unmerged: false },
          { path: 'notes.txt', code: 'M ', unmerged: false },
        ],
        diff: '',
        diffTruncated: false,
      },
      message: '',
      amend: false,
      selected: {},
      fieldReview: null,
      error: null,
      notice: null,
      merge: null,
      branchSwitchPrompt: null,
      newBranchPrompt: null,
      mergeBranchPrompt: null,
      deleteBranchPrompt: null,
      history: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    branches: [],
  })
})

describe('GitDialog: withholds per-file discard from the project\'s own file', () => {
  it('disables discard for the project file but keeps it enabled for another changed file', () => {
    render(<GitDialog />)

    const ownDiscard = screen.getByRole('button', { name: 'Cannot discard review.json here' })
    expect(ownDiscard).toBeDisabled()

    const otherDiscard = screen.getByRole('button', { name: 'Discard changes to notes.txt' })
    expect(otherDiscard).toBeEnabled()
  })
})
