import '@testing-library/jest-dom/vitest'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { AnnotationPanel } from './AnnotationPanel'

const st = () => useStore.getState()

function projectJson() {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: {
      schema: [{ name: 'Outcome', type: 'string', min: 1, max: 3 }],
    },
    papers: [{ id: 'p1', title: 'A Paper', authors: [], pdf: 'a.pdf', annotations: {} }],
  })
}

describe('AnnotationNode: cardinality-controlled instances', () => {
  it('starts at min instances, adds up to max, and disables Add at max', async () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    render(<AnnotationPanel />)

    expect(screen.getAllByLabelText(/Outcome/)).toHaveLength(1)
    const addBtn = screen.getByRole('button', { name: '+ Add' })

    await userEvent.click(addBtn)
    expect(screen.getAllByLabelText(/Outcome/)).toHaveLength(2)

    await userEvent.click(addBtn)
    expect(screen.getAllByLabelText(/Outcome/)).toHaveLength(3)
    expect(addBtn).toBeDisabled()
  })

  it('removes an instance down to min, and disables Remove at min', async () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    render(<AnnotationPanel />)

    await userEvent.click(screen.getByRole('button', { name: '+ Add' }))
    expect(screen.getAllByLabelText(/Outcome/)).toHaveLength(2)

    const removeButtons = screen.getAllByRole('button', { name: '×' })
    expect(removeButtons[0]).not.toBeDisabled()
    await userEvent.click(removeButtons[0])
    expect(screen.getAllByLabelText(/Outcome/)).toHaveLength(1)
    expect(screen.getByRole('button', { name: '×' })).toBeDisabled()
  })
})
