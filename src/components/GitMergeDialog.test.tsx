import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { useGitStore } from '../state/gitStore'
import { conflictId, type FieldConflict } from '../git/merge'
import { GitMergeDialog } from './GitMergeDialog'

// REQ-GIT-300: interactive conflict resolution. GitMergeDialog.test.ts already
// covers the pure `isForeignReview` helper; this renders the actual dialog
// against a MergeTree with a conflict in the reviewer's own tree and one in
// another reviewer's tree, and drives a resolution through the real UI.

function projectJson() {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    reviewers: 2,
    config: { schema: [{ name: 'Finding', type: 'string' }] },
    papers: [{ id: 'p1', title: 'A Paper', authors: [], pdf: 'a.pdf', annotations: {} }],
  })
}

const mineConflict: FieldConflict = {
  id: conflictId('p1', { kind: 'annotations' }, 'Finding'),
  paperId: 'p1',
  paperTitle: 'A Paper',
  tree: { kind: 'annotations' },
  canonical: 'Finding',
  label: 'Finding',
  type: 'string',
  base: 'base value',
  ours: 'my value',
  theirs: 'their value',
}

const otherReviewerConflict: FieldConflict = {
  id: conflictId('p1', { kind: 'review', reviewer: '2' }, 'Finding'),
  paperId: 'p1',
  paperTitle: 'A Paper',
  tree: { kind: 'review', reviewer: '2' },
  canonical: 'Finding',
  label: 'Finding',
  type: 'string',
  base: 'base value',
  ours: 'reviewer2 mine',
  theirs: 'reviewer2 theirs',
}

beforeEach(() => {
  useStore.getState().loadFromText(projectJson(), null, 'test.json')
  useStore.setState({ currentReviewer: '1' })
  const merged = useStore.getState().project!
  useGitStore.setState({
    panel: {
      phase: 'idle',
      status: null,
      message: '',
      amend: false,
      selected: {},
      fieldReview: null,
      error: null,
      notice: null,
      merge: {
        source: { kind: 'pull' },
        ref: 'origin/main',
        merged,
        conflicts: [mineConflict, otherReviewerConflict],
        resolutions: {},
        decided: {},
        notes: [],
      },
      branchSwitchPrompt: null,
      newBranchPrompt: null,
      mergeBranchPrompt: null,
      deleteBranchPrompt: null,
      history: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  })
})

describe('GitMergeDialog: resolving a conflicting row', () => {
  it('taking "mine" on a row records the resolution and updates progress', async () => {
    const user = userEvent.setup()
    const { container } = render(<GitMergeDialog />)

    expect(screen.getByText('0 of 2 decided', { selector: '.git-merge-progress' })).toBeInTheDocument()

    const rows = container.querySelectorAll('.git-merge-row')
    expect(rows).toHaveLength(2)
    const mineRow = rows[0] as HTMLElement // the annotations-tree conflict, listed first
    await user.click(within(mineRow).getByTitle('Use your value'))

    expect(useGitStore.getState().panel?.merge?.resolutions[mineConflict.id]).toBe('my value')
    expect(useGitStore.getState().panel?.merge?.decided[mineConflict.id]).toBe(true)
    expect(screen.getByText('1 of 2 decided', { selector: '.git-merge-progress' })).toBeInTheDocument()
  })

  it('marks another reviewer\'s conflict as foreign and excludes it from "Use all mine"', async () => {
    const user = userEvent.setup()
    const { container } = render(<GitMergeDialog />)

    const rows = container.querySelectorAll('.git-merge-row')
    expect(within(rows[1] as HTMLElement).getByText('another reviewer')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Use all mine' }))

    expect(useGitStore.getState().panel?.merge?.decided[mineConflict.id]).toBe(true)
    expect(useGitStore.getState().panel?.merge?.decided[otherReviewerConflict.id]).toBeUndefined()
  })
})
