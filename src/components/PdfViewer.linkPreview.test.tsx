import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, type ReactNode } from 'react'

/**
 * REQ-PDF-150: hovering an internal PDF link shows a cropped preview image
 * of its destination. This extends the shared `react-pdf` mock pattern from
 * `PdfViewer.chrome.test.tsx` (copied, not imported — vitest mocks are
 * file-scoped) with a fake pdf.js document good enough to drive
 * `resolveLinkPreview`'s real pipeline: getPage -> getAnnotations -> dest ->
 * getViewport/getTextContent -> canvas crop -> toDataURL.
 */
let mockNumPages = 1

const fakePage1Annotations = [{ id: 'link1', dest: [0, { name: 'XYZ' }, 50, 700, 0] }]

function makeFakePage() {
  return {
    getAnnotations: async () => fakePage1Annotations,
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
      convertToViewportPoint: (x: number, y: number) => [x, y],
    }),
    view: [0, 0, 600, 800],
    getTextContent: async () => ({ items: [] }),
  }
}

const fakePdfDoc = {
  numPages: mockNumPages,
  getPage: async (_n: number) => makeFakePage(),
  getDestination: async () => null,
  getPageIndex: async () => 0,
}

vi.mock('react-pdf', () => ({
  Document: ({
    children,
    onLoadSuccess,
    onLoadError,
    file,
  }: {
    children: ReactNode
    onLoadSuccess?: (doc: typeof fakePdfDoc) => void
    onLoadError?: (err: Error) => void
    file: string | null
  }) => {
    useEffect(() => {
      if (file === 'error.pdf') onLoadError?.(new Error('broken pdf'))
      else onLoadSuccess?.(fakePdfDoc)
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
        <canvas width={1200} height={1600} />
        {pageNumber === 1 && (
          <div className="react-pdf__Page__annotations">
            <section data-annotation-id="link1">
              <a href="#" data-testid="internal-link">
                link text
              </a>
            </section>
          </div>
        )}
        {children}
      </div>
    )
  },
}))

vi.mock('../platform/pdfjs', () => ({}))

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

// jsdom's getBoundingClientRect is all-zero by default; resolveLinkPreview
// bails early on a zero-size anchor or canvas rect, so give everything a
// generic non-zero one.
const GENERIC_RECT: DOMRect = {
  width: 600,
  height: 800,
  top: 0,
  left: 0,
  bottom: 800,
  right: 600,
  x: 0,
  y: 0,
  toJSON() {
    return this
  },
}
Element.prototype.getBoundingClientRect = () => GENERIC_RECT

HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: () => {} })) as unknown as typeof HTMLCanvasElement.prototype.getContext
HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,fake')

const { useStore } = await import('../state/store')
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
  mockNumPages = 1
  st().loadFromText(projectJson(), null, 'test.json')
  st().selectPaper('p1')
})

describe('PdfViewer: reference hover previews (REQ-PDF-150)', () => {
  it('shows a cropped preview image when hovering an internal link', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')
    const link = screen.getByTestId('internal-link')

    await userEvent.hover(link)

    const tooltip = await screen.findByRole('tooltip')
    const img = tooltip.querySelector('img')
    expect(img).toHaveAttribute('src', 'data:image/png;base64,fake')
  })

  it('hides the preview on mouseout', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')
    const link = screen.getByTestId('internal-link')

    await userEvent.hover(link)
    await screen.findByRole('tooltip')

    await userEvent.unhover(link)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
