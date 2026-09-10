import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent, screen, act } from '@testing-library/react'
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

function screeningProjectJson() {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: { schema: [{ name: 'Relevant', type: 'boolean' }], screening: { reasons: ['Off topic', 'Duplicate'] } },
    papers: [{ id: 'p1', title: 'Alpha', authors: [], pdf: 'a.pdf', annotations: {} }],
  })
}

describe('useKeybindings: global shortcuts (REQ-UI-10)', () => {
  it('Ctrl/Cmd+S saves the project (Shift+S saves as)', () => {
    render(<Host />)
    act(() => st().loadFromText(projectJson(), null, 'test.json'))
    let saved = 0
    let savedAs = 0
    useStore.setState({ save: async () => (saved++, true), saveAs: async () => (savedAs++, true) })

    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(saved).toBe(1)

    fireEvent.keyDown(window, { key: 'S', ctrlKey: true, shiftKey: true })
    expect(savedAs).toBe(1)
  })

  it('Ctrl/Cmd+O opens a project, but not while the editor is open', () => {
    render(<Host />)
    let opened = 0
    useStore.setState({ requestOpenProject: () => void opened++ })

    useEditorStore.setState({ open: true })
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true })
    expect(opened).toBe(0)

    useEditorStore.setState({ open: false })
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true })
    expect(opened).toBe(1)
  })

  it('Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes', () => {
    render(<Host />)
    let undone = 0
    let redone = 0
    useStore.setState({ undo: () => void undone++, redo: () => void redone++ })

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(undone).toBe(1)

    fireEvent.keyDown(window, { key: 'Z', ctrlKey: true, shiftKey: true })
    expect(redone).toBe(1)
  })

  it('Ctrl/Cmd+= zooms the PDF in; Ctrl/Cmd+Shift+= increases the font size instead', () => {
    render(<Host />)
    act(() => st().loadFromText(projectJson(), null, 'test.json'))
    const zoomBefore = st().pdfZoom
    fireEvent.keyDown(window, { key: '=', ctrlKey: true })
    expect(st().pdfZoom).toBeGreaterThan(zoomBefore)

    let fontIncreased = 0
    useStore.setState({ increaseFont: () => void fontIncreased++ })
    fireEvent.keyDown(window, { key: '=', ctrlKey: true, shiftKey: true })
    expect(fontIncreased).toBe(1)
  })
})

describe('useKeybindings: screening shortcuts (REQ-SCR-140)', () => {
  beforeEach(() => {
    act(() => {
      st().loadFromText(screeningProjectJson(), null, 'test.json')
      st().selectPaper('p1')
    })
  })

  it('I/E/U include, exclude, and un-decide the current paper', () => {
    render(<Host />)
    fireEvent.keyDown(window, { key: 'e' })
    expect(st().project!.papers[0].annotations.Decision[0].value).toBe('Exclude')

    fireEvent.keyDown(window, { key: 'i' })
    expect(st().project!.papers[0].annotations.Decision[0].value).toBe('Include')

    fireEvent.keyDown(window, { key: 'u' })
    expect(st().project!.papers[0].annotations.Decision[0].value).toBeNull()
  })

  it('a digit key excludes with the Nth configured reason', () => {
    render(<Host />)
    fireEvent.keyDown(window, { key: '2' })
    expect(st().project!.papers[0].annotations.Decision[0].value).toBe('Exclude')
    expect(st().project!.papers[0].annotations.Reason[0].value).toBe('Duplicate')
  })

  it('does nothing while typing in a field', () => {
    render(<Host />)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'e' })
    expect(st().project!.papers[0].annotations.Decision[0].value).toBeNull()
    input.remove()
  })
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
