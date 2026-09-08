import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { ScreeningPanel } from './ScreeningPanel'

const st = () => useStore.getState()

function screeningProjectJson() {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: { screening: { reasons: ['Wrong topic', 'Duplicate'] } },
    papers: [
      { id: 'p1', title: 'Paper One', authors: [], pdf: '', annotations: {} },
      { id: 'p2', title: 'Paper Two', authors: [], pdf: '', annotations: {} },
    ],
  })
}

beforeEach(() => {
  useStore.setState({ project: null })
})

describe('ScreeningPanel: live progress line (REQ-SCR-220)', () => {
  it('starts at 0 of N screened, all undecided', () => {
    st().loadFromText(screeningProjectJson(), null, 'test.json')
    render(<ScreeningPanel />)
    expect(screen.getByText(/0 of 2 screened/)).toBeInTheDocument()
    expect(screen.getByText(/0 included, 0 excluded, 2 left/)).toBeInTheDocument()
  })

  it('updates immediately after marking the current paper included', async () => {
    st().loadFromText(screeningProjectJson(), null, 'test.json')
    render(<ScreeningPanel />)

    await userEvent.click(screen.getByRole('button', { name: '✓ Include' }))

    expect(screen.getByText(/1 of 2 screened/)).toBeInTheDocument()
    expect(screen.getByText(/1 included, 0 excluded, 1 left/)).toBeInTheDocument()
  })

  it('reflects an exclude decision on the current paper only', async () => {
    st().loadFromText(screeningProjectJson(), null, 'test.json')
    render(<ScreeningPanel />)

    await userEvent.click(screen.getByRole('button', { name: '✕ Exclude' }))

    expect(screen.getByText(/1 of 2 screened/)).toBeInTheDocument()
    expect(screen.getByText(/0 included, 1 excluded, 1 left/)).toBeInTheDocument()
  })
})
