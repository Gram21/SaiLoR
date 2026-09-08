import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { useStore } from '../state/store'
import { useEditorStore } from '../state/editorStore'
import { useKeybindings } from './useKeybindings'
import { PaperList } from '../components/PaperList'

const st = () => useStore.getState()

// REQ-LST-50: keyboard navigation ([, ], Alt+Arrow) steps currentPaperId
// through the papers in the order the paper list currently shows them.
function projectJson() {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
    papers: [
      { id: 'p1', title: 'Alpha', authors: [], pdf: 'a.pdf', annotations: {} },
      { id: 'p2', title: 'Bravo', authors: [], pdf: 'b.pdf', annotations: {} },
      { id: 'p3', title: 'Charlie', authors: [], pdf: 'c.pdf', annotations: {} },
    ],
  })
}

function Host() {
  useKeybindings()
  return <PaperList />
}

beforeEach(() => {
  useStore.setState({ project: null, currentPaperId: null })
  useEditorStore.setState({ open: false })
})

describe('useKeybindings: paper navigation (REQ-LST-50)', () => {
  it('] and [ step to the next/previous paper in the visible list order', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    render(<Host />)

    fireEvent.keyDown(window, { key: ']' })
    expect(st().currentPaperId).toBe('p2')

    fireEvent.keyDown(window, { key: ']' })
    expect(st().currentPaperId).toBe('p3')

    // At the last paper, ] does not wrap around.
    fireEvent.keyDown(window, { key: ']' })
    expect(st().currentPaperId).toBe('p3')

    fireEvent.keyDown(window, { key: '[' })
    expect(st().currentPaperId).toBe('p2')
  })

  it('Alt+ArrowDown / Alt+ArrowUp also step through papers', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    render(<Host />)

    fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true })
    expect(st().currentPaperId).toBe('p2')

    fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true })
    expect(st().currentPaperId).toBe('p1')

    // At the first paper, Alt+ArrowUp does not wrap around.
    fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true })
    expect(st().currentPaperId).toBe('p1')
  })

  it('respects the filtered/visible order shown by the search box', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    render(<Host />)

    // Filter down to Alpha and Charlie only (both contain "ha", Bravo does
    // not) — Bravo drops out of the DOM order stepPaper reads from
    // `.paper-list [role="option"]`.
    fireEvent.change(screen.getByLabelText('Search papers'), { target: { value: 'ha' } })

    fireEvent.keyDown(window, { key: ']' })
    expect(st().currentPaperId).toBe('p3')
  })

  it('does not navigate while focus is inside an editable field', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    render(
      <>
        <Host />
        <input aria-label="Free text field" />
      </>,
    )

    const input = screen.getByLabelText('Free text field')
    input.focus()
    // Fired on the input itself (not window): it bubbles up to the window
    // listener with e.target set to the input, same as a real keystroke.
    fireEvent.keyDown(input, { key: ']' })
    expect(st().currentPaperId).toBe('p1')
  })

  it('Alt+Arrow still navigates even while focus is inside an editable field', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    render(
      <>
        <Host />
        <input aria-label="Free text field" />
      </>,
    )

    const input = screen.getByLabelText('Free text field')
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true })
    expect(st().currentPaperId).toBe('p2')
  })
})
