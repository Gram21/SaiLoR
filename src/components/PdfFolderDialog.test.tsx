// [utest->req~ann-200~1]
// [utest->req~lst-90~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { proposeNewPaper } from '../model/pdfFolder'
import { PdfFolderDialog } from './PdfFolderDialog'
import { PaperList } from './PaperList'

const st = () => useStore.getState()

function open() {
  st().loadFromText(
    JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'A', type: 'string' }] },
      papers: [{ id: 'p1', title: 'Old', authors: [], pdf: 'p1.pdf', annotations: {} }],
    }),
    null,
    'test.json',
  )
  useStore.setState({
    pdfProposals: [
      proposeNewPaper({ path: 'new/a.pdf', sha256: 'ha' }, { title: 'Paper A', authors: ['Ann'] }),
      proposeNewPaper({ path: 'new/b.pdf', sha256: 'hb' }, {}),
    ],
  })
}

const entry = (path: string) => screen.getByRole('region', { name: path })
const papers = () => st().project!.papers

beforeEach(() => {
  useStore.setState({ project: null, readOnly: false, pdfProposals: [], missingPdfs: [], pdfScanError: null })
})

describe('PdfFolderDialog', () => {
  it('adds one paper with an edited title as a manual value', async () => {
    open()
    render(<PdfFolderDialog />)
    expect(within(entry('new/b.pdf')).getByText('Metadata missing', { exact: false })).toBeInTheDocument()
    const title = within(entry('new/a.pdf')).getByRole('textbox', { name: 'Title' })
    await userEvent.clear(title)
    await userEvent.type(title, 'Paper A, revised')
    await userEvent.click(within(entry('new/a.pdf')).getByRole('button', { name: 'Add paper' }))
    expect(papers()).toHaveLength(2)
    const added = papers()[1]
    expect(added.title).toBe('Paper A, revised')
    expect(added.authors).toEqual(['Ann'])
    expect(added.pdf).toBe('new/a.pdf')
    expect(added.extra).toEqual({ pdfSha256: 'ha', metadataSource: { title: 'manual', authors: 'pdfinfo' } })
    expect(st().pdfProposals.map((p) => p.file.sha256)).toEqual(['hb'])
    expect(screen.queryByRole('region', { name: 'new/a.pdf' })).toBeNull()
  })

  it('keeps a skipped file in the scan result and adds nothing', async () => {
    open()
    render(<PdfFolderDialog />)
    await userEvent.click(within(entry('new/a.pdf')).getByRole('button', { name: 'Skip' }))
    expect(within(entry('new/a.pdf')).getByText('Not added')).toBeInTheDocument()
    expect(papers()).toHaveLength(1)
    expect(st().pdfProposals).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Add all (1)' })).toBeEnabled()
  })

  it('records an ignored file in the project', async () => {
    open()
    render(<PdfFolderDialog />)
    await userEvent.click(within(entry('new/b.pdf')).getByRole('button', { name: 'Ignore' }))
    expect(st().project!.extra.ignoredPdfs).toEqual(['hb'])
    expect(papers()).toHaveLength(1)
    expect(screen.queryByRole('region', { name: 'new/b.pdf' })).toBeNull()
  })

  it('adds all files that are not skipped', async () => {
    open()
    render(<PdfFolderDialog />)
    await userEvent.click(screen.getByRole('button', { name: 'Add all (2)' }))
    expect(papers().map((p) => p.pdf)).toEqual(['p1.pdf', 'new/a.pdf', 'new/b.pdf'])
    expect(papers()[2].title).toBe('b')
    expect(st().pdfProposals).toEqual([])
    expect(screen.getByText('The PDF folder has no new files.')).toBeInTheDocument()
  })

  it('writes nothing in read-only mode', () => {
    open()
    useStore.setState({ readOnly: true })
    render(<PdfFolderDialog />)
    expect(screen.getByRole('button', { name: 'Add all (2)' })).toBeDisabled()
    expect(within(entry('new/a.pdf')).getByRole('button', { name: 'Add paper' })).toBeDisabled()
    expect(within(entry('new/a.pdf')).getByRole('button', { name: 'Ignore' })).toBeDisabled()
  })
})

describe('PaperList missing PDF badge', () => {
  it('marks a paper whose PDF file is missing', () => {
    open()
    useStore.setState({ missingPdfs: ['p1'] })
    render(<PaperList />)
    expect(screen.getByText('missing')).toBeInTheDocument()
  })
})
