// [utest->req~con-550~1]
// [utest->req~con-570~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore, STRICT_MANAGER } from '../state/store'
import { StrictLockBanner } from './StrictLockBanner'
import { AnnotationPanel } from './AnnotationPanel'

const st = () => useStore.getState()

beforeEach(() => {
  st().setReadOnly(false)
  st().loadFromText(
    JSON.stringify({
      version: 1,
      config: {
        schema: [{ name: 'Relevant', type: 'boolean' }],
        reviewers: 2,
        strict: true,
        persons: [{ id: 'ann', name: 'Ann' }],
        assignments: { a: [{ person: 'ann', seat: 1 }] },
      },
      papers: [
        {
          id: 'a',
          title: 'A',
          authors: [],
          pdf: 'a.pdf',
          reviewsFinished: { '1': true },
          reviewsLock: { '1': { finishedAt: '2026-11-05T10:00:00Z' } },
        },
      ],
    }),
    null,
    'strict.json',
  )
})

describe('StrictLockBanner', () => {
  it('shows the banner without Reopen to the person', () => {
    st().choosePerson('ann')
    render(<StrictLockBanner />)
    expect(screen.getByRole('status')).toHaveTextContent('Finished. Ask the manager to reopen.')
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull()
  })

  it('lets the Manager reopen after a confirmation', async () => {
    st().choosePerson(STRICT_MANAGER)
    st().selectPaper('a')
    st().selectReviewer('1')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<StrictLockBanner />)
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(confirm).toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
    expect(st().project!.papers[0].reviewsLock?.['1']?.reopenedAt).toBeDefined()
    confirm.mockRestore()
  })

  it('shows the locked form read-only in the annotation panel', () => {
    st().choosePerson('ann')
    render(<AnnotationPanel />)
    expect(screen.getByRole('status')).toHaveTextContent('Finished. Ask the manager to reopen.')
    expect(screen.getByLabelText('Relevant')).toBeDisabled()
  })
})
