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
      schema: [
        { name: 'Is RCT', type: 'boolean' },
        { name: 'Sample Size', type: 'number' },
        { name: 'Pub Year', type: 'year' },
        { name: 'Notes', type: 'string' },
        { name: 'Design', type: 'string', options: ['RCT', 'Cohort', 'Case study'] },
      ],
    },
    papers: [{ id: 'p1', title: 'A Paper', authors: [], pdf: 'a.pdf', annotations: {} }],
  })
}

describe('Field: type-specific controls', () => {
  it('renders a checkbox for boolean, number inputs for number/year, a textarea for free string, a combobox for an enum', async () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    render(<AnnotationPanel />)

    const bool = screen.getByLabelText('Is RCT')
    expect(bool).toHaveAttribute('type', 'checkbox')

    const num = screen.getByLabelText('Sample Size')
    expect(num).toHaveAttribute('type', 'number')

    const year = screen.getByLabelText('Pub Year')
    expect(year).toHaveAttribute('type', 'number')
    expect(year).toHaveAttribute('min')
    expect(year).toHaveAttribute('max')

    const notes = screen.getByLabelText('Notes')
    expect(notes.tagName).toBe('TEXTAREA')

    // The enum field renders as a combobox (ComboBox component), not a bare
    // <select> — its accessible role is "combobox".
    expect(screen.getByRole('combobox', { name: 'Design' })).toBeInTheDocument()

    await userEvent.type(num, '42')
    expect(st().project!.papers[0].annotations['Sample Size']?.[0].value).toBe(42)

    await userEvent.click(bool)
    expect(st().project!.papers[0].annotations['Is RCT']?.[0].value).toBe(true)
  })
})

describe('Field: grab value from PDF selection', () => {
  it('shows a grab button only on free-text/number/year fields, and inserts the current PDF selection', async () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    useStore.setState({ pdfSelection: '  hello from pdf  ' })
    render(<AnnotationPanel />)

    // No grab button on the boolean or enum fields.
    const boolRow = screen.getByLabelText('Is RCT').closest('.field-row')!
    expect(boolRow.querySelector('.grab-btn')).toBeNull()
    const designRow = screen.getByRole('combobox', { name: 'Design' }).closest('.field-row')!
    expect(designRow.querySelector('.grab-btn')).toBeNull()

    const notesRow = screen.getByLabelText('Notes').closest('.field-row')!
    const grabBtn = notesRow.querySelector('.grab-btn') as HTMLButtonElement
    expect(grabBtn).not.toBeNull()
    await userEvent.click(grabBtn)
    expect(st().project!.papers[0].annotations['Notes']?.[0].value).toBe('hello from pdf')
  })

  it('parses a plausible year out of the selection for a year field', async () => {
    st().loadFromText(projectJson(), null, 'test.json')
    st().selectPaper('p1')
    useStore.setState({ pdfSelection: 'Vol. 12, 2021' })
    render(<AnnotationPanel />)

    const yearRow = screen.getByLabelText('Pub Year').closest('.field-row')!
    const grabBtn = yearRow.querySelector('.grab-btn') as HTMLButtonElement
    await userEvent.click(grabBtn)
    expect(st().project!.papers[0].annotations['Pub Year']?.[0].value).toBe(2021)
  })
})
