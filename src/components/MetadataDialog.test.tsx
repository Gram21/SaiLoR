// [utest->req~ann-180~1]
// [utest->req~con-530~1]
// [utest->req~dat-470~1]
// [utest->req~lst-80~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { MetadataDialog } from './MetadataDialog'
import { PaperList } from './PaperList'

const st = () => useStore.getState()

function open(config: Record<string, unknown>) {
  st().loadFromText(
    JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'A', type: 'string' }], ...config },
      papers: [
        { id: 'p1', title: 'Orignal Title', authors: ['Ada Lovelace'], year: 2020, pdf: 'p1.pdf', annotations: {} },
        { id: 'p2', title: 'Second', authors: [], pdf: 'p2.pdf', annotations: {} },
      ],
    }),
    null,
    'test.json',
  )
}

const entry = (id: string) => screen.getByRole('region', { name: id })

beforeEach(() => {
  useStore.setState({ project: null, currentPaperId: null, currentReviewer: null, strictPerson: null })
})

describe('MetadataDialog', () => {
  it('writes a manual correction only after Accept', async () => {
    open({ metadataEdit: 'project' })
    st().selectPaper('p1')
    render(<MetadataDialog onClose={() => {}} />)
    const title = within(entry('p1')).getByRole('textbox', { name: 'Title' })
    await userEvent.clear(title)
    await userEvent.type(title, 'Original Title')
    expect(st().project!.papers[0].title).toBe('Orignal Title')
    await userEvent.click(within(entry('p1')).getByRole('button', { name: 'Accept' }))
    expect(st().project!.papers[0].title).toBe('Original Title')
    expect(st().project!.papers[0].id).toBe('p1')
    expect(screen.queryByRole('region', { name: 'p1' })).toBeNull()
  })

  it('changes nothing on Skip', async () => {
    open({ metadataEdit: 'project' })
    st().selectPaper('p1')
    render(<MetadataDialog onClose={() => {}} />)
    await userEvent.click(within(entry('p1')).getByRole('button', { name: 'Skip' }))
    expect(screen.queryByRole('region', { name: 'p1' })).toBeNull()
    expect(st().dirty).toBe(false)
  })

  it('accepts all proposals at once and remembers an ignored one', async () => {
    open({ metadataEdit: 'project' })
    useStore.setState({
      scanPdfMetadata: vi.fn(async () => [
        { paperId: 'p1', values: { doi: '10.1/a' } },
        { paperId: 'p2', values: { title: 'Junk' } },
      ]),
    })
    render(<MetadataDialog onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Check PDFs' }))
    await userEvent.click(within(entry('p2')).getByRole('button', { name: 'Ignore' }))
    expect(st().project!.papers[1].title).toBe('Second')
    expect(st().project!.papers[1].extra.metadataIgnored).toEqual({ title: 'Junk' })
    await userEvent.click(screen.getByRole('button', { name: 'Accept all (1)' }))
    expect(st().project!.papers[0].doi).toBe('10.1/a')
    expect(st().past.length).toBe(2)
  })

  it('shows a disagreement between reviewers in Consolidation', () => {
    open({ metadataEdit: 'annotation', reviewers: 2 })
    st().selectReviewer('1')
    st().applyMetadataEdits([{ paperId: 'p1', values: { title: 'One' } }])
    st().selectReviewer('2')
    st().applyMetadataEdits([{ paperId: 'p1', values: { title: 'Two' } }])
    st().selectReviewer('consolidation')
    render(<MetadataDialog onClose={() => {}} />)
    const section = screen.getByRole('heading', { name: 'Reviewer corrections: p1' }).closest('section')!
    expect(within(section).getByText(/The reviewers disagree/)).toHaveTextContent('Reviewer 1: One; Reviewer 2: Two')
    expect(screen.getByRole('button', { name: 'Accept all (0)' })).toBeDisabled()
  })
})

describe('paper list badge', () => {
  it('marks a corrected paper and shows the corrected title', () => {
    open({ metadataEdit: 'project' })
    st().applyMetadataEdits([{ paperId: 'p1', values: { title: 'Original Title' } }])
    render(<PaperList />)
    expect(screen.getByText('Original Title')).toBeInTheDocument()
    expect(screen.getAllByRole('img', { name: 'Corrected: Title' })).toHaveLength(1)
  })
})
