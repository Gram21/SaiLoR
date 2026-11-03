import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HANDLE, mockPlatform, paper, projectText } from './strictTestProject'

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore, STRICT_MANAGER } = await import('../state/store')
const { AnnotationPanel } = await import('./AnnotationPanel')

const st = () => useStore.getState()

function openConsolidation(person: string) {
  st().choosePerson(person)
  st().selectPaper('a')
  st().selectReviewer('consolidation')
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  st().setReadOnly(false)
  st().loadFromText(projectText(), HANDLE, 'strict.json')
})

describe('consolidation gate', () => {
  it('names the persons who have not finished and hides the form', () => {
    openConsolidation(STRICT_MANAGER)
    render(<AnnotationPanel />)
    expect(screen.getByText('Not finished yet: Ann, Bob')).toBeInTheDocument()
    expect(screen.queryByText('Relevant')).not.toBeInTheDocument()
  })

  it('opens when all assigned persons have finished', () => {
    const papers = [paper('a', { reviewsFinished: { '1': true, '2': true } }), paper('b'), paper('c')]
    st().loadFromText(projectText(papers), HANDLE, 'strict.json')
    openConsolidation(STRICT_MANAGER)
    render(<AnnotationPanel />)
    expect(screen.queryByText(/Not finished yet/)).not.toBeInTheDocument()
  })

  it('lets the Manager open it anyway after the confirmation', async () => {
    openConsolidation(STRICT_MANAGER)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<AnnotationPanel />)
    await userEvent.click(screen.getByRole('button', { name: 'Open anyway' }))
    expect(screen.getByText(/Not finished yet/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open anyway' }))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Not finished yet/)).not.toBeInTheDocument()
  })
})
