import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { Splitter, offsetFromStart } from './Splitter'

// jsdom has no PointerEvent constructor, so RTL's fireEvent.pointer* falls
// back to a bare Event that drops clientX. Polyfill with a MouseEvent
// subclass, which jsdom does implement, so clientX survives.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {}
  // @ts-expect-error test-only polyfill
  window.PointerEvent = PointerEventPolyfill
}

describe('Splitter', () => {
  it('reports pointer movement while dragging and marks the body as resizing', () => {
    const onResize = vi.fn()
    const onResizeEnd = vi.fn()
    const { container } = render(<Splitter onResize={onResize} onResizeEnd={onResizeEnd} />)
    const separator = container.querySelector('[role="separator"]')!

    fireEvent.pointerDown(separator, { clientX: 100 })
    expect(document.body.classList.contains('resizing')).toBe(true)

    fireEvent.pointerMove(window, { clientX: 120 })
    fireEvent.pointerMove(window, { clientX: 140 })
    expect(onResize).toHaveBeenNthCalledWith(1, 120)
    expect(onResize).toHaveBeenNthCalledWith(2, 140)

    fireEvent.pointerUp(window)
    expect(onResizeEnd).toHaveBeenCalledTimes(1)
    expect(document.body.classList.contains('resizing')).toBe(false)

    fireEvent.pointerMove(window, { clientX: 160 })
    expect(onResize).toHaveBeenCalledTimes(2)
  })

  it('treats pointercancel the same as pointerup: removes listeners and ends the drag', () => {
    const onResize = vi.fn()
    const onResizeEnd = vi.fn()
    const { container } = render(<Splitter onResize={onResize} onResizeEnd={onResizeEnd} />)
    const separator = container.querySelector('[role="separator"]')!

    fireEvent.pointerDown(separator, { clientX: 50 })
    fireEvent.pointerMove(window, { clientX: 60 })
    expect(onResize).toHaveBeenCalledWith(60)

    fireEvent.pointerCancel(window)
    expect(onResizeEnd).toHaveBeenCalledTimes(1)
    expect(document.body.classList.contains('resizing')).toBe(false)

    fireEvent.pointerMove(window, { clientX: 70 })
    expect(onResize).toHaveBeenCalledTimes(1)
  })
})

// [utest->req~ui-140~1]
describe('offsetFromStart', () => {
  it('measures from the left edge, or from the right edge in a right-to-left document', () => {
    const rect = { left: 100, right: 900, width: 800 } as DOMRect
    expect(offsetFromStart(300, rect)).toBe(200)
    document.documentElement.dir = 'rtl'
    try {
      expect(offsetFromStart(300, rect)).toBe(600)
    } finally {
      document.documentElement.dir = 'ltr'
    }
  })
})
