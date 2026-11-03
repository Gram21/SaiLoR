import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HANDLE, mockPlatform, projectText, written } from './strictTestProject'

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore, STRICT_MANAGER } = await import('../state/store')
const { StrictPersonBar } = await import('./StrictPersonBar')

const st = () => useStore.getState()

beforeEach(() => {
  localStorage.clear()
  written.length = 0
  vi.restoreAllMocks()
  st().setReadOnly(false)
  st().loadFromText(projectText(), HANDLE, 'strict.json')
})

describe('StrictPersonBar', () => {
  it('names the person and switches only without unsaved changes', async () => {
    st().choosePerson('ann')
    render(<StrictPersonBar />)
    expect(screen.getByText('Working as Ann')).toBeInTheDocument()

    act(() => st().setAnnotationFinished(true))
    expect(await screen.findByRole('button', { name: 'Switch person' })).toBeDisabled()

    await act(() => st().save())
    const button = await screen.findByRole('button', { name: 'Switch person' })
    expect(button).toBeEnabled()
    await userEvent.click(button)
    expect(st().strictPerson).toBeNull()
  })

  it('finishes all assigned papers and saves after the confirmation', async () => {
    st().choosePerson('ann')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<StrictPersonBar />)
    await userEvent.click(screen.getByRole('button', { name: 'Finish' }))
    expect(confirm).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(written).toHaveLength(1))
    const saved = JSON.parse(written[0])
    const finished = (id: string) => saved.papers.find((p: { id: string }) => p.id === id).reviewsFinished
    expect(finished('a')).toMatchObject({ '1': true })
    expect(finished('c')).toMatchObject({ '2': true })
    expect(await screen.findByRole('button', { name: 'Finish' })).toBeDisabled()
  })

  it('does nothing when the confirmation is cancelled', async () => {
    st().choosePerson('ann')
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<StrictPersonBar />)
    await userEvent.click(screen.getByRole('button', { name: 'Finish' }))
    expect(written).toHaveLength(0)
    expect(st().dirty).toBe(false)
  })

  it('has no Finish button for the Manager', () => {
    st().choosePerson(STRICT_MANAGER)
    render(<StrictPersonBar />)
    expect(screen.getByText('Working as Manager')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Finish' })).not.toBeInTheDocument()
  })
})
