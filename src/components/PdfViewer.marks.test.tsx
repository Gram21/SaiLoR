import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fireEvent } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'

/**
 * Copied verbatim from `PdfViewer.chrome.test.tsx` (mocks are per-file in
 * vitest, so this can't just import that file's setup). See that file's own
 * doc comment for why each piece exists.
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

// jsdom has no caretRangeFromPoint (used by `handleMarkMouseDown` to anchor a
// real text selection under a dragged mark) — stub it to a no-op so the drag
// path runs without throwing; returning null means the code's own `if
// (anchor)`/`if (focus)` guards just skip the selection-extension work, which
// this suite doesn't need to verify.
document.caretRangeFromPoint = vi.fn().mockReturnValue(null)

const { useStore, PDF_ZOOM_MIN: _PDF_ZOOM_MIN } = await import('../state/store')
const { PdfViewer } = await import('./PdfViewer')

const st = () => useStore.getState()
const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 }

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

/** Stub a rendered page's rect so click-coordinate math (placeNote) and the
 *  drag-threshold math (handleMarkMouseDown) produce sane, non-NaN numbers. */
function stubPageRect(page: number, box = { left: 0, top: 0, width: 600, height: 800 }) {
  const el = screen.getByTestId(`pdf-page-${page}`)
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height }),
    configurable: true,
  })
  return el
}

describe('PdfViewer: create highlights from a seeded selection (REQ-PDF-70)', () => {
  it('renders a .pdf-mark-rect for a highlight created via addHighlight', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')

    act(() => {
      st().addHighlight(1, [rect], '#ffe066')
    })

    const page1 = screen.getByTestId('pdf-page-1')
    const markRect = page1.querySelector('.pdf-mark-rect')
    expect(markRect).toBeInTheDocument()
    expect((markRect as HTMLElement).style.left).toBe(`${rect.x * 100}%`)
  })
})

describe('PdfViewer: cross-page highlights (REQ-PDF-80)', () => {
  it('renders both grouped fragments as overlay rects on their own pages', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')

    // A cross-page highlight is two `PdfMark` records sharing a `groupId`,
    // one fragment per page (see `commitHighlight`'s loop over `spans`), not
    // one mark whose rects span pages.
    act(() => {
      const groupId = 'group-1'
      st().addHighlight(1, [rect], '#ffe066', undefined, 'spans two pages', groupId)
      st().addHighlight(2, [rect], '#ffe066', undefined, 'spans two pages', groupId)
    })

    expect(screen.getByTestId('pdf-page-1').querySelector('.pdf-mark-rect')).toBeInTheDocument()
    expect(screen.getByTestId('pdf-page-2').querySelector('.pdf-mark-rect')).toBeInTheDocument()
    expect(screen.getByTestId('pdf-page-3').querySelector('.pdf-mark-rect')).not.toBeInTheDocument()

    // The grouped fragments stay in sync (store-level behavior, exercised
    // here through the component): editing one's comment via the store
    // propagates to the other.
    const marks = st().currentPdfMarks()
    act(() => st().setMarkComment(marks[0].id, 'noted'))
    expect(st().currentPdfMarks().every((m) => m.comment === 'noted')).toBe(true)
  })
})

describe('PdfViewer: sticky notes (REQ-PDF-90)', () => {
  it('placing a note after activating "Add sticky note" creates a note-kind mark', async () => {
    const user = userEvent.setup()
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')
    stubPageRect(1)

    await user.click(screen.getByRole('button', { name: 'Annotation tools' }))
    await user.click(screen.getByRole('button', { name: 'Add sticky note' }))

    const page1 = screen.getByTestId('pdf-page-1')
    fireEvent.click(page1, { clientX: 60, clientY: 80 })

    expect(st().currentPdfMarks()).toHaveLength(1)
    expect(st().currentPdfMarks()[0].kind).toBe('note')
    expect(page1.querySelector('.pdf-mark-note')).toBeInTheDocument()
  })
})

describe('PdfViewer: edit marks via popover (REQ-PDF-100)', () => {
  it('clicking a highlight opens its popover; comment/color/delete drive the store', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')

    let id: string | null = null
    act(() => {
      id = st().addHighlight(1, [rect], '#ffe066')
    })

    const markRect = screen.getByTestId('pdf-page-1').querySelector('.pdf-mark-rect') as HTMLElement
    // A plain click (mousedown+mouseup at the same point) opens the popover —
    // see `handleMarkMouseDown`.
    fireEvent.mouseDown(markRect, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseUp(document, { clientX: 10, clientY: 10 })

    const textarea = await screen.findByPlaceholderText('Add a comment…')
    fireEvent.change(textarea, { target: { value: 'hello note' } })
    expect(st().currentPdfMarks().find((m) => m.id === id)?.comment).toBe('hello note')

    fireEvent.click(screen.getByRole('button', { name: 'Set color #a5d8ff' }))
    expect(st().currentPdfMarks().find((m) => m.id === id)?.color).toBe('#a5d8ff')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(st().currentPdfMarks().find((m) => m.id === id)).toBeUndefined()
  })
})

describe('PdfViewer: cycle marks in reading order (REQ-PDF-130)', () => {
  it('Next annotation advances the "current" mark through pages in order', async () => {
    // `scrollToMark` (cycling's scroll path) moves `containerRef`'s own
    // `scrollTop` directly, not `.scrollIntoView` — that's only used by
    // typed-page-number navigation (`scrollToPage`) and the mark-not-rendered
    // fallback. jsdom's zeroed layout makes a `scrollTop` delta unobservable
    // here, so the real, assertable "landed on this mark" signal is the
    // `.flash` class `flashAndScrollTo` adds to the current mark's overlay.
    const user = userEvent.setup()
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')

    act(() => {
      st().addHighlight(1, [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }])
      st().addHighlight(2, [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }])
      st().addHighlight(3, [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }])
    })

    await user.click(screen.getByRole('button', { name: 'Annotation tools' }))
    const next = screen.getByRole('button', { name: 'Next annotation' })

    await user.click(next)
    expect(screen.getByTestId('pdf-page-1').querySelector('.pdf-mark-rect')?.className).toContain('flash')
    expect(screen.getByText('1 / 3')).toBeInTheDocument()

    await user.click(next)
    expect(screen.getByTestId('pdf-page-2').querySelector('.pdf-mark-rect')?.className).toContain('flash')
    expect(screen.getByTestId('pdf-page-1').querySelector('.pdf-mark-rect')?.className).not.toContain('flash')
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
  })
})

describe('PdfViewer: selection can drag through a mark (REQ-PDF-140)', () => {
  it('a plain click opens the popover; a drag does not', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')

    act(() => {
      st().addHighlight(1, [rect])
    })
    const markRect = screen.getByTestId('pdf-page-1').querySelector('.pdf-mark-rect') as HTMLElement

    // Plain click: mousedown and mouseup at the same point — opens the popover.
    fireEvent.mouseDown(markRect, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseUp(document, { clientX: 10, clientY: 10 })
    expect(await screen.findByPlaceholderText('Add a comment…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByPlaceholderText('Add a comment…')).not.toBeInTheDocument()

    // Drag: mousedown, then a mousemove past the drag threshold, then mouseup
    // elsewhere — must NOT open the popover (the gesture is treated as a
    // text-selection drag through the mark, not a click on it).
    fireEvent.mouseDown(markRect, { button: 0, clientX: 10, clientY: 10 })
    const scroll = document.querySelector('.pdf-scroll') as HTMLElement
    expect(scroll.className).toContain('pdf-marks-dragging')
    fireEvent.mouseMove(document, { clientX: 60, clientY: 60 })
    fireEvent.mouseUp(document, { clientX: 60, clientY: 60 })

    expect(screen.queryByPlaceholderText('Add a comment…')).not.toBeInTheDocument()
    expect(scroll.className).not.toContain('pdf-marks-dragging')
  })

  it('anchors the selection with marks already click-through and suppresses the native mousedown', async () => {
    render(<PdfViewer />)
    await screen.findByTestId('pdf-document')
    act(() => {
      st().addHighlight(1, [rect])
    })
    const markRect = screen.getByTestId('pdf-page-1').querySelector('.pdf-mark-rect') as HTMLElement
    const scroll = document.querySelector('.pdf-scroll') as HTMLElement

    let draggingAtAnchor = false
    vi.mocked(document.caretRangeFromPoint).mockImplementationOnce(() => {
      draggingAtAnchor = scroll.classList.contains('pdf-marks-dragging')
      return null
    })
    const notCancelled = fireEvent.mouseDown(markRect, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseUp(document, { clientX: 10, clientY: 10 })

    expect(draggingAtAnchor).toBe(true)
    expect(notCancelled).toBe(false)
  })
})
