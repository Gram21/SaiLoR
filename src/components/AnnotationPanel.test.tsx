import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { AnnotationPanel } from './AnnotationPanel'

const st = () => useStore.getState()

function projectJson() {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: {
      schema: [
        { name: 'Study Type', type: 'string', required: true },
        { name: 'Sample Size', type: 'number' },
      ],
    },
    papers: [
      { id: 'p1', title: 'A Paper', authors: [], pdf: 'a.pdf', annotations: {} },
      { id: 'p2', title: 'B Paper', authors: [], pdf: 'b.pdf', annotations: {} },
    ],
  })
}

describe('AnnotationPanel: renders the schema form for the selected paper', () => {
  it('shows a placeholder when no paper is selected', () => {
    useStore.setState({ project: null })
    render(<AnnotationPanel />)
    expect(screen.getByText('Select a paper to annotate.')).toBeInTheDocument()
  })

  it('renders one field per schema entry, and the paper title, once a paper is selected', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    render(<AnnotationPanel />)
    expect(screen.getByText('A Paper')).toBeInTheDocument()
    expect(screen.getByLabelText('Study Type')).toBeInTheDocument()
    expect(screen.getByLabelText('Sample Size')).toBeInTheDocument()
  })
})

describe('AnnotationPanel: "Annotation finished" sign-off', () => {
  beforeEach(() => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
  })

  it('is unchecked by default and ticking it records the sign-off', async () => {
    render(<AnnotationPanel />)
    const checkbox = screen.getByRole('checkbox', { name: /Annotation finished/ })
    expect(checkbox).not.toBeChecked()
    await userEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(st().project!.papers[0].finished).toBe(true)
  })

  it('flags a paper finished while a required field is still empty', async () => {
    render(<AnnotationPanel />)
    await userEvent.click(screen.getByRole('checkbox', { name: /Annotation finished/ }))
    expect(screen.getByText(/required fields are empty/)).toBeInTheDocument()
  })
})

describe('AnnotationPanel: jump to field', () => {
  it('scrolls the requested field into view, flashes it, then clears the request', () => {
    // jsdom doesn't implement scrollIntoView.
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {})
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    render(<AnnotationPanel />)
    act(() => st().setPendingFieldJump('Study Type'))
    expect(st().flashFieldPath).toBe('Study Type')
    expect(st().pendingFieldJump).toBe(null)
    const el = document.querySelector('[data-canonical="Study Type"]')
    expect(el).toHaveClass('field-flash')
  })
})

describe('AnnotationPanel: markings from screening', () => {
  const mark = { id: 'm', page: 1, kind: 'highlight' as const, rects: [{ x: 0, y: 0, width: 0.1, height: 0.1 }], color: '#ffe066', comment: '', createdAt: '', updatedAt: '' }

  it('offers the box only on a paper the screening marked', async () => {
    st().loadFromText(projectJson(), null, 'test.json')
    useStore.setState({ screeningMarks: { p1: [{ seat: '1', mark }] }, showScreeningMarks: false })
    st().selectPaper('p1')
    const { unmount } = render(<AnnotationPanel />)
    const box = screen.getByLabelText(/Show markings from screening \(1\)/)
    await userEvent.click(box)
    expect(st().showScreeningMarks).toBe(true)
    unmount()

    act(() => st().selectPaper('p2'))
    render(<AnnotationPanel />)
    expect(screen.queryByLabelText(/Show markings from screening/)).not.toBeInTheDocument()
  })
})
