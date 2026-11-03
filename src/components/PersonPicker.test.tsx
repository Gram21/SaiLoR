import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HANDLE, mockPlatform, projectText } from './strictTestProject'

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore, STRICT_MANAGER } = await import('../state/store')
const { PersonPicker } = await import('./PersonPicker')
const { PaperList } = await import('./PaperList')

const st = () => useStore.getState()

beforeEach(() => {
  localStorage.clear()
  st().setReadOnly(false)
  st().loadFromText(projectText(), HANDLE, 'strict.json')
})

describe('PersonPicker', () => {
  it('asks who works, with the paper count of each person and the disclaimer', () => {
    render(<PersonPicker />)
    expect(screen.getByRole('dialog', { name: 'Who are you?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Ann\s*2 papers/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Bob\s*2 papers/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Manager/ })).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('not security')
  })

  it('closes after a choice, and the paper list then shows only the assigned papers', async () => {
    render(
      <>
        <PersonPicker />
        <PaperList />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: /Ann/ }))
    expect(screen.queryByRole('dialog', { name: 'Who are you?' })).not.toBeInTheDocument()
    expect(st().strictPerson).toBe('ann')
    expect(screen.getByText('Title a')).toBeInTheDocument()
    expect(screen.getByText('Title c')).toBeInTheDocument()
    expect(screen.queryByText('Title b')).not.toBeInTheDocument()
  })

  it('shows every paper to the Manager', async () => {
    render(
      <>
        <PersonPicker />
        <PaperList />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: /Manager/ }))
    expect(st().strictPerson).toBe(STRICT_MANAGER)
    expect(screen.getByText('Title b')).toBeInTheDocument()
  })

  it('does not show when strict mode is off', () => {
    const json = JSON.parse(projectText())
    json.config.strict = false
    st().loadFromText(JSON.stringify(json), HANDLE, 'strict.json')
    render(<PersonPicker />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
