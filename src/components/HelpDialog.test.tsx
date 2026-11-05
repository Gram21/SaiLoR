// [utest->req~ui-150~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { HelpDialog } from './HelpDialog'
import { SettingsDialog } from './SettingsDialog'

const st = () => useStore.getState()

beforeEach(() => {
  useStore.setState({ helpOpen: true, userSettingsOpen: false })
})

describe('HelpDialog (REQ-UI-150)', () => {
  it('closes the help and opens Settings from its Open settings button', async () => {
    const user = userEvent.setup()
    render(
      <>
        <HelpDialog />
        <SettingsDialog />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(st().helpOpen).toBe(false)
    expect(st().userSettingsOpen).toBe(true)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })
})
