import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, type ReactNode } from 'react'

// Shared mock harness copied verbatim from PdfViewer.chrome.test.tsx (vi.mock
// is file-scoped, so it can't be imported/reused across test files).
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

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)

// jsdom implements no layout at all, not even Range.getClientRects/
// getBoundingClientRect (unlike Element, which has them as always-zero
// stubs) — polyfill with zero rects so PdfViewer's rect-based code (search
// highlight painting, selection-toolbar geometry) doesn't crash. Tests that
// depend on real rect values (selection toolbar) are documented as skipped.
const zeroRect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} }
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => zeroRect as DOMRect

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
  mockNumPages = 3
  st().loadFromText(projectJson(), null, 'test.json')
  st().selectPaper('p1')
})

describe('PdfViewer: in-PDF search (REQ-PDF-50)', () => {
  it('typing a query populates match count from the fake text layers', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')

    await userEvent.click(screen.getByRole('button', { name: 'Search in PDF' }))
    const input = await screen.findByRole('textbox', { name: 'Search in PDF' })
    await userEvent.type(input, 'sample')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200)) // clear the 150ms debounce
    })

    // Each of the 3 fake pages renders "Page N sample text" once.
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
  })

  it('shows 0 / 0 for a query with no matches', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')

    await userEvent.click(screen.getByRole('button', { name: 'Search in PDF' }))
    const input = await screen.findByRole('textbox', { name: 'Search in PDF' })
    await userEvent.type(input, 'nonexistent-term')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })

    expect(screen.getByText('0 / 0')).toBeInTheDocument()
  })
})

describe('PdfViewer: case-sensitive search toggle (REQ-PDF-55)', () => {
  it('changes the match count based on case sensitivity', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')

    await userEvent.click(screen.getByRole('button', { name: 'Search in PDF' }))
    const input = await screen.findByRole('textbox', { name: 'Search in PDF' })
    // Fake text is "Page N sample text" — capitalized "Page" only.
    await userEvent.type(input, 'PAGE')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })
    expect(screen.getByText('1 / 3')).toBeInTheDocument() // case-insensitive by default

    await userEvent.click(screen.getByRole('button', { name: 'Toggle case-sensitive search' }))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })
    expect(screen.getByText('0 / 0')).toBeInTheDocument() // "PAGE" !== "Page" case-sensitively
  })
})

describe('PdfViewer: jump history for internal links (REQ-PDF-40)', () => {
  it('records a back-jump when the scroll position moves after a link click, and jumpBack/jumpForward move between them', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')

    // Buttons only render once there's history to navigate.
    expect(screen.queryByRole('button', { name: 'Jump back' })).not.toBeInTheDocument()

    const container = document.querySelector('.pdf-scroll') as HTMLDivElement
    const scrollTo = vi.fn()
    Object.defineProperty(container, 'scrollTo', { value: scrollTo, configurable: true })

    // The real annotation layer (pdf.js DOM) isn't reproduced by the mock, so
    // an <a> is inserted directly into a page to stand in for an internal
    // link — onPdfClickCapture only cares that the click target is inside an
    // <a>, not that it's a genuine pdf.js annotation.
    const page1 = screen.getByTestId('pdf-page-1')
    const link = document.createElement('a')
    link.href = '#'
    page1.appendChild(link)

    container.scrollTop = 0
    fireEvent.click(link)
    // recordJumpIfMoved polls scrollTop asynchronously (starting ~40ms after
    // the click) to see if the jump actually moved the view — simulate the
    // jump completing by moving scrollTop before that poll fires.
    container.scrollTop = 500

    const jumpBackBtn = await screen.findByRole('button', { name: 'Jump back' })
    await waitFor(() => expect(jumpBackBtn).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Jump forward' })).toBeDisabled()

    await userEvent.click(jumpBackBtn)
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
    await waitFor(() => expect(jumpBackBtn).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Jump forward' })).toBeEnabled()

    await userEvent.click(screen.getByRole('button', { name: 'Jump forward' }))
    expect(scrollTo).toHaveBeenCalledWith({ top: 500 })
  })
})

describe('PdfViewer: capture normalized text selection (REQ-PDF-60)', () => {
  it('writes the selected text to the store on mouseup', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')
    expect(st().pdfSelection).toBe('')

    const page1 = screen.getByTestId('pdf-page-1')
    const span = page1.querySelector('span') as HTMLSpanElement

    // The JSX `{pageNumber}` interpolation splits the span's text across
    // multiple text nodes ("Page ", "1", " sample text") — select the whole
    // span so `sel.toString()` concatenates them back into one string.
    const range = document.createRange()
    range.selectNodeContents(span)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)

    fireEvent.mouseUp(document.querySelector('.pdf-scroll') as HTMLDivElement)

    expect(st().pdfSelection).toBe('Page 1 sample text')
    // Note: the highlight-color toolbar (selectionToolbar/"pdf-highlight-toolbar")
    // is not asserted here — it only appears once `Range.getClientRects()`
    // returns rects with width/height > 1, which jsdom never produces (no
    // real layout), so that part of the flow can't be driven in jsdom.
  })
})

describe('PdfViewer: jump from an AI evidence quote (REQ-LLM-460)', () => {
  it('locates an exact quote and clears the pending request', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')

    act(() => {
      st().requestPdfFind('p1', 'sample text')
    })

    await waitFor(() => expect(st().pdfFindRequest).toBeNull())
  })

  it('falls back to a shorter leading word sequence when the full quote is not verbatim in the text layer', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')

    // Not present verbatim (extra trailing words), but its first 3 words —
    // "Page 1 sample" — are, so the progressive fallback should still land it.
    act(() => {
      st().requestPdfFind('p1', 'Page 1 sample text nonsense trailing words here')
    })

    await waitFor(() => expect(st().pdfFindRequest).toBeNull())
  })

  it('shows a non-blocking notice and drops the request when the quote is nowhere to be found', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')

    // Fake timers only from here: the give-up timeout is what's under test,
    // not the (real-timer) PDF-loading/text-layer setup above.
    vi.useFakeTimers()
    try {
      act(() => {
        st().requestPdfFind('p1', 'this text is nowhere in the document at all')
      })
      act(() => {
        vi.advanceTimersByTime(3000)
      })

      expect(screen.getByText("Couldn't locate this quote in the PDF.")).toBeInTheDocument()
      expect(st().pdfFindRequest).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
