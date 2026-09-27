import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useStore } from '../state/store'
import { conflictId, type FieldConflict } from '../git/merge'
import { ConflictResolutionDialog, type ConflictDialogLabels } from './ConflictResolutionDialog'

// REQ-LLM-570: the AI's own reviewer seat should read "AI (Reviewer N)" here
// too, not the plain "Reviewer N" every other seat gets — see `seatLabel`.

function projectJson() {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: { schema: [{ name: 'Finding', type: 'string' }], reviewers: 2, aiSeat: true },
    papers: [{ id: 'p1', title: 'A Paper', authors: [], pdf: 'a.pdf', annotations: {} }],
  })
}

const labels: ConflictDialogLabels = {
  title: 'Resolve merge conflicts',
  intro: 'intro',
  theirsValue: 'the remote value',
  useAllTheirs: 'Use all remote',
  cancel: 'Cancel',
  cancelTitle: 'cancel',
  finish: 'Finish',
  finishTitle: 'finish',
}

const aiSeatConflict: FieldConflict = {
  id: conflictId('p1', { kind: 'review', reviewer: '2' }, 'Finding'),
  paperId: 'p1',
  paperTitle: 'A Paper',
  tree: { kind: 'review', reviewer: '2' },
  canonical: 'Finding',
  label: 'Finding',
  type: 'string',
  base: 'base value',
  ours: 'mine',
  theirs: 'theirs',
}

beforeEach(() => {
  useStore.getState().loadFromText(projectJson(), null, 'test.json')
  useStore.setState({ currentReviewer: '1' })
})

describe('ConflictResolutionDialog: seat labels', () => {
  it('labels the AI seat (the last reviewer, with aiSeat on) "AI (Reviewer N)"', () => {
    render(
      <ConflictResolutionDialog
        merge={{ conflicts: [aiSeatConflict], resolutions: {}, decided: {}, notes: [] }}
        labels={labels}
        error={null}
        onResolve={() => {}}
        onTakeAll={() => {}}
        onFinish={() => {}}
        onCancel={() => {}}
        onDismissError={() => {}}
      />,
    )
    expect(screen.getByText('AI (Reviewer 2)')).toBeInTheDocument()
  })

  it('labels an ordinary reviewer\'s seat "Reviewer N" when there is no AI seat', () => {
    useStore.getState().loadFromText(
      JSON.stringify({
        version: 1,
        title: 'My Review',
        config: { schema: [{ name: 'Finding', type: 'string' }], reviewers: 2 },
        papers: [{ id: 'p1', title: 'A Paper', authors: [], pdf: 'a.pdf', annotations: {} }],
      }),
      null,
      'test.json',
    )
    render(
      <ConflictResolutionDialog
        merge={{ conflicts: [aiSeatConflict], resolutions: {}, decided: {}, notes: [] }}
        labels={labels}
        error={null}
        onResolve={() => {}}
        onTakeAll={() => {}}
        onFinish={() => {}}
        onCancel={() => {}}
        onDismissError={() => {}}
      />,
    )
    expect(screen.getByText('Reviewer 2')).toBeInTheDocument()
  })
})
