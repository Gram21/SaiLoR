import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useStore } from '../state/store'
import { ScreeningRecord } from './ScreeningRecord'

const st = () => useStore.getState()

function screeningProjectJson(paper: Record<string, unknown>) {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: { screening: { reasons: ['Wrong topic'] } },
    papers: [{ id: 'p1', authors: [], pdf: '', annotations: {}, ...paper }],
  })
}

beforeEach(() => {
  useStore.setState({ project: null })
})

describe('ScreeningRecord: abstract-based screening view (REQ-SCR-280)', () => {
  it('shows the paper abstract', () => {
    st().loadFromText(
      screeningProjectJson({ title: 'A Paper', abstract: 'This study investigates X.' }),
      null,
      'test.json',
    )
    render(<ScreeningRecord />)
    expect(screen.getByText('This study investigates X.')).toBeInTheDocument()
  })

  it('shows a placeholder when there is no abstract', () => {
    st().loadFromText(screeningProjectJson({ title: 'A Paper' }), null, 'test.json')
    render(<ScreeningRecord />)
    expect(screen.getByText('No abstract recorded for this paper.')).toBeInTheDocument()
  })
})

describe('ScreeningRecord: caution notice for extracted abstracts (REQ-SCR-300)', () => {
  it('shows the caution notice when the abstract was extracted from the PDF', () => {
    st().loadFromText(
      screeningProjectJson({ title: 'A Paper', abstract: 'Extracted text.', abstractFromPdf: true }),
      null,
      'test.json',
    )
    render(<ScreeningRecord />)
    expect(screen.getByText(/extracted automatically from the PDF text/)).toBeInTheDocument()
  })

  it('does not show the caution notice for a normal abstract', () => {
    st().loadFromText(
      screeningProjectJson({ title: 'A Paper', abstract: 'Normal abstract.' }),
      null,
      'test.json',
    )
    render(<ScreeningRecord />)
    expect(screen.queryByText(/extracted automatically from the PDF text/)).not.toBeInTheDocument()
  })
})
