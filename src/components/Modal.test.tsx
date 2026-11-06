// [utest->req~ui-180~1]
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Modal } from './Modal'

function setup(onClose?: () => void) {
  render(
    <Modal onClose={onClose} className="x" aria-label="Test">
      <button>first</button>
      <button>last</button>
    </Modal>,
  )
  return screen.getByRole('dialog')
}

describe('Modal', () => {
  it('marks the dialog as modal and adds the extra class', () => {
    const dialog = setup()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.className).toBe('modal x')
  })

  it('closes on an overlay click but not on a click inside', () => {
    const onClose = vi.fn()
    const dialog = setup(onClose)
    fireEvent.click(screen.getByText('first'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(dialog.parentElement!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('wraps Tab and Shift+Tab inside the dialog', () => {
    const dialog = setup()
    const [first, last] = [screen.getByText('first'), screen.getByText('last')]
    last.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})
