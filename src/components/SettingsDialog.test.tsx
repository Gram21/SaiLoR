// [utest->req~ui-90~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { useAiStore } from '../state/aiStore'
import { useGitStore } from '../state/gitStore'
import { useKeybindings } from '../hooks/useKeybindings'
import { SettingsDialog } from './SettingsDialog'
import { setLanguage } from '../i18n'

function Host() {
  useKeybindings()
  return (
    <>
      <button type="button">outside</button>
      <SettingsDialog />
    </>
  )
}

const st = () => useStore.getState()

beforeEach(() => {
  const items = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  })
  useStore.setState({ userSettingsOpen: false, theme: 'light', fontScale: 1, autosaveEnabled: false })
  useAiStore.setState({ settingsOpen: false })
  useGitStore.setState({ probe: null })
})

describe('SettingsDialog (REQ-UI-90, REQ-UI-100)', () => {
  it('opens with Ctrl/Cmd+, and closes with Escape', () => {
    render(<Host />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(st().userSettingsOpen).toBe(false)
  })

  it('does not open over another dialog', () => {
    render(
      <>
        <Host />
        <div className="modal-overlay" />
      </>,
    )
    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    expect(st().userSettingsOpen).toBe(false)
  })

  it('closes from the close button and from the overlay', async () => {
    const user = userEvent.setup()
    act(() => st().setUserSettingsOpen(true))
    const { container } = render(<SettingsDialog />)
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(st().userSettingsOpen).toBe(false)
    act(() => st().setUserSettingsOpen(true))
    await user.click(container.querySelector('.modal-overlay')!)
    expect(st().userSettingsOpen).toBe(false)
  })

  it('moves focus in, traps Tab and gives focus back on close', async () => {
    const user = userEvent.setup()
    render(<Host />)
    const outside = screen.getByRole('button', { name: 'outside' })
    outside.focus()
    act(() => st().setUserSettingsOpen(true))
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close).toHaveFocus()
    await user.tab({ shift: true })
    const last = screen.getByRole('button', { name: 'AI models…' })
    expect(last).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(outside).toHaveFocus()
  })

  it('labels every control', () => {
    act(() => st().setUserSettingsOpen(true))
    render(<SettingsDialog />)
    for (const name of ['General', 'Language', 'AI', 'Git']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('combobox', { name: 'Theme' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Font size' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Autosave every 5 minutes' })).toBeInTheDocument()
  })

  it('General writes the theme, font size and autosave keys', async () => {
    const user = userEvent.setup()
    act(() => st().setUserSettingsOpen(true))
    render(<SettingsDialog />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Theme' }), 'dark')
    expect(localStorage.getItem('slr.theme')).toBe('dark')
    await user.click(screen.getByRole('button', { name: 'Increase font size' }))
    expect(localStorage.getItem('slr.fontScale')).toBe('1.1')
    expect(screen.getByText('110%')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Decrease font size' }))
    await user.click(screen.getByRole('button', { name: 'Decrease font size' }))
    expect(localStorage.getItem('slr.fontScale')).toBe('0.9')
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(localStorage.getItem('slr.fontScale')).toBe('1')
    await user.click(screen.getByRole('checkbox', { name: 'Autosave every 5 minutes' }))
    expect(localStorage.getItem('slr.autosave')).toBe('1')
    await user.click(screen.getByRole('checkbox', { name: 'Autosave every 5 minutes' }))
    expect(localStorage.getItem('slr.autosave')).toBe('0')
  })

  it('AI opens the existing AI models dialog, and Escape then leaves Settings open', async () => {
    const user = userEvent.setup()
    act(() => st().setUserSettingsOpen(true))
    render(<SettingsDialog />)
    await user.click(screen.getByRole('button', { name: 'AI models…' }))
    expect(useAiStore.getState().settingsOpen).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(st().userSettingsOpen).toBe(true)
  })

  it('Git shows the detected git or the reason it is missing', () => {
    act(() => st().setUserSettingsOpen(true))
    render(<SettingsDialog />)
    expect(screen.getByText('Looking for git…')).toBeInTheDocument()
    act(() => useGitStore.setState({ probe: { available: true, version: 'git version 2.43.0', error: '' } }))
    expect(screen.getByText('SaiLoR uses the git on your PATH: git version 2.43.0.')).toBeInTheDocument()
    act(() => useGitStore.setState({ probe: { available: false, version: '', error: 'git was not found' } }))
    expect(screen.getByText('git was not found')).toBeInTheDocument()
  })

  // [utest->req~ui-110~1]
  it('switches the dialog to German and stores the choice', async () => {
    const user = userEvent.setup()
    act(() => st().setUserSettingsOpen(true))
    render(<SettingsDialog />)
    const select = screen.getByRole('combobox', { name: 'User interface language' })
    expect(select).toHaveValue('en')
    expect(screen.getByRole('option', { name: 'Deutsch' })).toHaveAttribute('lang', 'de')
    try {
      await user.selectOptions(select, 'de')
      expect(localStorage.getItem('slr.language')).toBe('de')
      expect(document.documentElement.lang).toBe('de')
      expect(screen.getByRole('dialog', { name: 'Einstellungen' })).toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Sprache' })).toBeInTheDocument()
      expect(screen.getByRole('combobox', { name: 'Sprache der Oberfläche' })).toHaveValue('de')
    } finally {
      act(() => setLanguage('en'))
    }
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })
})
