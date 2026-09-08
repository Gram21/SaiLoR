import '@testing-library/jest-dom/vitest'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useStore } from '../state/store'
import { AnnotationPanel } from './AnnotationPanel'

const st = () => useStore.getState()

function projectJson() {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: {
      schema: [
        {
          name: 'Design',
          type: 'string',
          required: true,
          description: 'See https://example.com/protocol for details.',
        },
        { name: 'Plain', type: 'string' },
      ],
    },
    papers: [{ id: 'p1', title: 'A Paper', authors: [], pdf: 'a.pdf', annotations: {} }],
  })
}

describe('NodeName: required-field marker', () => {
  it('marks a required field, and leaves a non-required one unmarked', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    render(<AnnotationPanel />)

    const designName = screen.getByText('Design').closest('.anno-name')!
    expect(designName.querySelector('.anno-required')).not.toBeNull()

    const plainName = screen.getByText('Plain').closest('.anno-name')!
    expect(plainName.querySelector('.anno-required')).toBeNull()
  })
})

describe('NodeName: field descriptions with links', () => {
  it('right-click opens a popover rendering the description with a real link', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    render(<AnnotationPanel />)

    const designName = screen.getByText('Design').closest('.anno-name')!
    fireEvent.contextMenu(designName)

    const popover = screen.getByRole('dialog', { name: 'Design description' })
    const link = popover.querySelector('a')
    expect(link).not.toBeNull()
    expect(link).toHaveAttribute('href', 'https://example.com/protocol')
  })
})
