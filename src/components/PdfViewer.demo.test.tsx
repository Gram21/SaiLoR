import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DEMO_NO_PDF } from '../demo/text'

vi.mock('../demo/mode', () => ({ DEMO_MODE: true }))
vi.mock('react-pdf', () => ({ Document: () => null, Page: () => null }))
vi.mock('../platform/pdfjs', () => ({}))
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

const mockPlatform = {
  kind: 'browser' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  needsPdfFolderGrant: () => false,
  getPdfSource: async (): Promise<{ url: string }> => {
    throw new Error(DEMO_NO_PDF)
  },
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('../state/store')
const { PdfViewer } = await import('./PdfViewer')

const st = () => useStore.getState()

function load(venue: string | undefined) {
  st().loadFromText(
    JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
      papers: [{ id: 'p1', title: 'A Paper', authors: ['Jane Doe'], pdf: 'pdfs/a.pdf', venue, annotations: {} }],
    }),
    null,
    'demo.json',
  )
  st().selectPaper('p1')
}

// [utest->req~plt-453~1]
describe('PdfViewer in the demo: a paper without a bundled PDF', () => {
  it('shows a neutral notice and links to the arXiv page of the paper', async () => {
    load('arXiv preprint: https://arxiv.org/abs/2601.19548')
    render(<PdfViewer />)
    expect(await screen.findByText(DEMO_NO_PDF)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Read this paper on arXiv' })).toHaveAttribute(
      'href',
      'https://arxiv.org/abs/2601.19548',
    )
    expect(document.querySelector('.pdf-error')).toBeNull()
  })

  it('shows the notice without a link when the paper names no arXiv page', async () => {
    load('Journal of Things')
    render(<PdfViewer />)
    expect(await screen.findByText(DEMO_NO_PDF)).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
