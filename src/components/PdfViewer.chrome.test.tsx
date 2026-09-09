import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, type ReactNode } from 'react'

/**
 * `PdfViewer` renders through `react-pdf`, which drives a real pdf.js worker
 * and canvas — neither exists in jsdom. This mock replaces just enough of
 * `react-pdf`'s public surface to exercise `PdfViewer`'s own chrome (zoom,
 * page navigation, jump history, search) without ever touching pdf.js: a
 * fake `Document` calls `onLoadSuccess({ numPages })` once mounted, and a
 * fake `Page` renders its `pageNumber` and `children` (the mark overlays and
 * text layer PdfViewer itself owns) into a plain div, plus a couple of fake
 * "text" spans so search/selection tests elsewhere have something to select.
 * This is the shared harness other `PdfViewer.*.test.tsx` files reuse.
 */
let mockNumPages = 3

vi.mock('react-pdf', () => ({
  Document: ({
    children,
    onLoadSuccess,
    onLoadError,
    file,
  }: {
    children: ReactNode
    onLoadSuccess?: (doc: { numPages: number }) => void
    onLoadError?: (err: Error) => void
    file: string | null
  }) => {
    useEffect(() => {
      if (file === 'error.pdf') onLoadError?.(new Error('broken pdf'))
      else onLoadSuccess?.({ numPages: mockNumPages })
    }, [file])
    if (file === 'error.pdf') return null
    return <div data-testid="pdf-document">{children}</div>
  },
  Page: ({
    pageNumber,
    children,
    inputRef,
    onRenderTextLayerSuccess,
  }: {
    pageNumber: number
    children?: ReactNode
    inputRef?: (el: HTMLDivElement | null) => void
    onRenderTextLayerSuccess?: () => void
  }) => {
    useEffect(() => onRenderTextLayerSuccess?.(), [])
    return (
      <div data-testid={`pdf-page-${pageNumber}`} ref={inputRef} className="react-pdf__Page">
        <div className="react-pdf__Page__textContent">
          <span>Page {pageNumber} sample text</span>
        </div>
        {children}
      </div>
    )
  },
}))

vi.mock('../platform/pdfjs', () => ({}))

// jsdom has no ResizeObserver; PdfViewer only reads the container's width
// from it, which stays 0 in jsdom either way.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)

const mockPlatform = {
  kind: 'browser' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  needsPdfFolderGrant: () => false,
  getPdfSource: async () => ({ url: 'blob:fake-pdf-url' }),
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore, PDF_ZOOM_MIN, PDF_ZOOM_MAX } = await import('../state/store')
const { PdfViewer } = await import('./PdfViewer')

const st = () => useStore.getState()

function projectJson() {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
    papers: [{ id: 'p1', title: 'A Paper', authors: ['Jane Doe'], pdf: 'a.pdf', annotations: {} }],
  })
}

beforeEach(() => {
  mockNumPages = 3
  st().loadFromText(projectJson(), null, 'test.json')
  st().selectPaper('p1')
})

describe('PdfViewer: renders the PDF (REQ-PDF-10)', () => {
  it('resolves the source and mounts one Page per document page', async () => {
    render(<PdfViewer />)
    expect(await screen.findByTestId('pdf-document')).toBeInTheDocument()
    expect(screen.getByTestId('pdf-page-1')).toBeInTheDocument()
    expect(screen.getByTestId('pdf-page-3')).toBeInTheDocument()
  })

  it('surfaces a load error instead of silently showing nothing', async () => {
    st().loadFromText(
      JSON.stringify({
        version: 1,
        config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
        papers: [{ id: 'p2', title: 'Bad', authors: [], pdf: 'a.pdf', annotations: {} }],
      }),
      null,
      'test2.json',
    )
    st().selectPaper('p2')
    mockPlatform.getPdfSource = async () => ({ url: 'error.pdf' })
    render(<PdfViewer />)
    expect(await screen.findByText(/Could not load PDF: broken pdf/)).toBeInTheDocument()
    mockPlatform.getPdfSource = async () => ({ url: 'blob:fake-pdf-url' })
  })
})

describe('PdfViewer: zoom controls (REQ-PDF-20)', () => {
  it('zoom in/out/reset move the store\'s pdfZoom within its clamped range', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')
    expect(st().pdfZoom).toBe(1)

    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(st().pdfZoom).toBeGreaterThan(1)

    await userEvent.click(screen.getByRole('button', { name: 'Reset zoom' }))
    expect(st().pdfZoom).toBe(1)

    for (let i = 0; i < 20; i++) await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(st().pdfZoom).toBe(PDF_ZOOM_MIN)

    act(() => st().resetPdfZoom())
    for (let i = 0; i < 20; i++) await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(st().pdfZoom).toBe(PDF_ZOOM_MAX)
  })
})

describe('PdfViewer: page navigation (REQ-PDF-30)', () => {
  it('typing a page number and pressing Enter scrolls the requested page into view', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')
    const scrollIntoView = vi.fn()
    for (const p of [1, 2, 3]) {
      const el = screen.getByTestId(`pdf-page-${p}`)
      Object.defineProperty(el, 'scrollIntoView', { value: scrollIntoView, configurable: true })
    }

    const pageInput = screen.getByRole('textbox', { name: 'Current page' })
    await userEvent.clear(pageInput)
    await userEvent.type(pageInput, '2{Enter}')

    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('Previous/Next page buttons step by one page, clamped to the document bounds', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')
    for (const p of [1, 2, 3]) {
      Object.defineProperty(screen.getByTestId(`pdf-page-${p}`), 'scrollIntoView', {
        value: vi.fn(),
        configurable: true,
      })
    }
    const pageInput = screen.getByRole('textbox', { name: 'Current page' }) as HTMLInputElement

    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    await waitFor(() => expect(pageInput.value).toBe('1')) // already at page 1, does not go below it

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(pageInput.value).toBe('2'))
  })
})
