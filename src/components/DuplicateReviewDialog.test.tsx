import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DuplicateReviewDraft, EditorPaper } from '../state/editorStore'

vi.mock('../platform', () => ({
  getPlatform: () => ({
    kind: 'electron' as const,
    getRecents: () => [],
    rememberProject: () => {},
    forgetRecent: () => [],
    checkRecents: async (e: unknown[]) => e,
    getOsInfo: () => null,
  }),
}))

const { useEditorStore } = await import('../state/editorStore')
const { DuplicateReviewDialog } = await import('./DuplicateReviewDialog')

const st = () => useEditorStore.getState()

const EXISTING: EditorPaper = {
  uid: 'u1',
  id: 'p1',
  title: 'A Study of Something',
  authors: 'Jane Doe',
  doi: '10.1000/xyz',
  year: '2020',
  venue: '',
  abstract: '',
  pdf: '',
}

function draft(): DuplicateReviewDraft {
  return {
    sourceName: 'refs.bib',
    entries: [
      { title: 'A Study of Something', authors: ['Jane Doe'], doi: '10.1000/abc' },
      { title: 'Something Else Entirely', authors: ['John Roe'] },
    ],
    verdicts: [
      { kind: 'probable', target: { where: 'existing', index: 0 }, reason: { via: 'title', score: 1 } },
      { kind: 'new' },
    ],
    existingUids: ['u1'],
    decisions: {},
  }
}

beforeEach(() => {
  useEditorStore.setState({
    open: true,
    mode: 'edit',
    papers: [EXISTING],
    duplicateReview: draft(),
    dirty: false,
    notice: null,
  })
})

describe('DuplicateReviewDialog: human decision on probable duplicates (REQ-DAT-340)', () => {
  it('shows only the probable row, not the unambiguous "new" one', () => {
    render(<DuplicateReviewDialog />)
    expect(screen.getByText('0 of 1 decided')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('blocks import until every probable row is decided', async () => {
    render(<DuplicateReviewDialog />)
    const importBtn = screen.getByRole('button', { name: /^Import 2 references$/ })
    expect(importBtn).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(screen.getByText('1 of 1 decided')).toBeInTheDocument()
    expect(importBtn).toBeEnabled()
  })

  it('merges a row marked Duplicate into the matched paper rather than adding a new one', async () => {
    render(<DuplicateReviewDialog />)
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    await userEvent.click(screen.getByRole('button', { name: /^Import 2 references$/ }))

    expect(st().duplicateReview).toBeNull()
    expect(st().papers).toHaveLength(2) // the merged one + the unambiguous "new" one
    expect(st().papers.find((p) => p.uid === 'u1')?.doi).toBe('10.1000/xyz') // untouched, not overwritten
  })

  it('adds a row marked Different as its own paper instead of merging it', async () => {
    render(<DuplicateReviewDialog />)
    await userEvent.click(screen.getByRole('button', { name: 'Different' }))
    await userEvent.click(screen.getByRole('button', { name: /^Import 2 references$/ }))

    expect(st().papers).toHaveLength(3)
    expect(st().papers.some((p) => p.title === 'A Study of Something' && p.uid !== 'u1')).toBe(true)
  })

  it('cancelling discards the whole batch — nothing is imported', async () => {
    render(<DuplicateReviewDialog />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel import' }))
    expect(st().duplicateReview).toBeNull()
    expect(st().papers).toHaveLength(1)
  })
})
