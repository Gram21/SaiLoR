import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { ErrorPanel } from './ErrorPanel'

beforeEach(() => {
  useStore.setState({ loadError: null })
})

describe('ErrorPanel', () => {
  it('renders nothing when there is no error', () => {
    const { container } = render(<ErrorPanel />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the message and details when an error is set', () => {
    useStore.setState({
      loadError: { message: 'Could not open file', details: ['bad.json: invalid syntax'] },
    })
    render(<ErrorPanel />)
    expect(screen.getByText('Could not open file')).toBeInTheDocument()
    expect(screen.getByText('bad.json: invalid syntax')).toBeInTheDocument()
  })

  it('clears the error when the close button is clicked', async () => {
    useStore.setState({
      loadError: { message: 'Could not open file', details: [] },
    })
    render(<ErrorPanel />)
    await userEvent.click(screen.getByRole('button'))
    expect(useStore.getState().loadError).toBeNull()
  })

  it('clears the error when clicking the overlay background', async () => {
    useStore.setState({
      loadError: { message: 'Could not open file', details: [] },
    })
    const { container } = render(<ErrorPanel />)
    await userEvent.click(container.querySelector('.error-overlay')!)
    expect(useStore.getState().loadError).toBeNull()
  })

  it('does not clear the error when clicking inside the error box', async () => {
    useStore.setState({
      loadError: { message: 'Could not open file', details: [] },
    })
    render(<ErrorPanel />)
    await userEvent.click(screen.getByText('Could not open file'))
    expect(useStore.getState().loadError).not.toBeNull()
  })
})
