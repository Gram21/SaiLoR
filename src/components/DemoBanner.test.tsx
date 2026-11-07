import '@testing-library/jest-dom/vitest'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DemoBanner } from './DemoBanner'

// [utest->req~plt-448~1]
// [utest->req~plt-455~1]
describe('DemoBanner', () => {
  it('says nothing is saved and links to the releases page', () => {
    render(<DemoBanner />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Demo: nothing is saved. Download the app to keep your work.',
    )
    expect(screen.getByRole('link', { name: 'Download the app' })).toHaveAttribute(
      'href',
      'https://github.com/Gram21/SaiLoR/releases',
    )
  })

  it('folds into a chip when hidden, and the chip brings the notice back', async () => {
    const user = userEvent.setup()
    render(<DemoBanner />)
    await user.click(screen.getByRole('button', { name: 'Hide the demo notice' }))
    expect(screen.queryByRole('status')).toBeNull()
    const chip = screen.getByRole('button', { name: 'Demo' })
    await user.click(chip)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('links back to the project page from the notice and while the notice is folded', async () => {
    const user = userEvent.setup()
    render(<DemoBanner />)
    expect(screen.getByRole('link', { name: '← Back to project page' })).toHaveAttribute('href', '../')
    await user.click(screen.getByRole('button', { name: 'Hide the demo notice' }))
    expect(screen.getByRole('link', { name: '← Back to project page' })).toHaveAttribute('href', '../')
    expect(screen.getByRole('button', { name: 'Demo' })).toBeInTheDocument()
  })
})
