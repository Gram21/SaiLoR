import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useEffect } from 'react'
import type { RecentEntry, SaveHandle } from '../../platform/adapter'

// Same localStorage polyfill as store.readingPosition.test.ts — reading
// position is persisted the same per-machine way as the reviewer seat.
if (typeof globalThis.localStorage === 'undefined') {
  const backing = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
    },
    configurable: true,
  })
}

// jsdom performs no real layout. Rect geometry here deliberately models the
// exact regression this suite guards: every page starts at a small
// "loading placeholder" height, and only grows to its real rendered height
// once that page's own `onRenderTextLayerSuccess` has fired — the same two
// phases a real PDF page goes through (react-pdf mounts the page's wrapper
// div immediately, but its real content/height only lands once pdf.js
// finishes rendering it).
const PLACEHOLDER_HEIGHT = 20
const REAL_HEIGHT = 1000
const renderedPages = new Set<number>()
Element.prototype.getBoundingClientRect = function () {
  const idx = this instanceof HTMLElement ? Number(this.dataset.pageIndex ?? '0') : 0
  let top = 0
  for (let i = 0; i < idx; i++) top += renderedPages.has(i) ? REAL_HEIGHT : PLACEHOLDER_HEIGHT
  const height = renderedPages.has(idx) ? REAL_HEIGHT : PLACEHOLDER_HEIGHT
  return { left: 0, top, right: 800, bottom: top + height, width: 800, height, x: 0, y: top, toJSON() {} }
}
// jsdom implements neither of these.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver
const scrollIntoViewSpy = vi.fn()
Element.prototype.scrollIntoView = scrollIntoViewSpy

const NUM_PAGES = 5
// Filled by each mocked `<Page>` on mount; the test calls these directly
// (instead of the mock firing them itself) to control exactly when each
// page's text layer "finishes rendering", the way real, staggered pdf.js
// rendering would.
const textLayerCallbacks = new Map<number, () => void>()
vi.mock('react-pdf', () => ({
  pdfjs: { GlobalWorkerOptions: {} as Record<string, unknown> },
  Document: (props: { onLoadSuccess?: (doc: { numPages: number }) => void; children?: React.ReactNode }) => {
    useEffect(() => props.onLoadSuccess?.({ numPages: NUM_PAGES }), [])
    return <>{props.children}</>
  },
  Page: (props: {
    pageNumber: number
    inputRef?: (el: HTMLDivElement | null) => void
    onRenderTextLayerSuccess?: () => void
    children?: React.ReactNode
  }) => {
    useEffect(() => {
      textLayerCallbacks.set(props.pageNumber, () => props.onRenderTextLayerSuccess?.())
      return () => {
        textLayerCallbacks.delete(props.pageNumber)
      }
    }, [props.pageNumber, props.onRenderTextLayerSuccess])
    return (
      <div
        className="react-pdf__Page"
        data-page-index={props.pageNumber - 1}
        ref={props.inputRef}
        style={{ position: 'relative' }}
      >
        <div className="react-pdf__Page__textContent" />
        {props.children}
      </div>
    )
  },
}))

const mockPlatform = {
  kind: 'electron' as const,
  getOsInfo: () => null,
  getRecents: () => [] as RecentEntry[],
  rememberProject: () => {},
  forgetRecent: () => [] as RecentEntry[],
  checkRecents: async (entries: RecentEntry[]) => entries,
  openProject: async () => null,
  openRecent: async () => null,
  saveProject: async (_text: string, handle: SaveHandle) => handle,
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: 'blob:fake-pdf-source' }),
  needsPdfFolderGrant: () => false,
  grantPdfFolderAccess: async () => {},
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
  getGit: () => null,
}

vi.mock('../../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('../../state/store')
const { PdfViewer } = await import('../../components/PdfViewer')

const schema = [{ name: 'A', type: 'string' as const }]
const project = JSON.stringify({
  version: 1,
  config: { schema },
  papers: [{ id: 'p1', title: 'One', authors: [], pdf: 'p1.pdf', annotations: {} }],
})

const st = () => useStore.getState()
const handle: SaveHandle = { kind: 'electron', path: '/reviews/reading-position.json' }

beforeEach(() => {
  localStorage.clear()
  cleanup()
  scrollIntoViewSpy.mockClear()
  renderedPages.clear()
  textLayerCallbacks.clear()
})

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function scrolledPageIndices(): number[] {
  return scrollIntoViewSpy.mock.instances.map((el) => Number((el as HTMLElement).dataset.pageIndex))
}

describe('reopening a project scrolls to the remembered PDF page', () => {
  it('re-snaps to the target page as earlier pages grow from placeholder to real height, instead of landing wherever the placeholder happened to sit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      st().loadFromText(project, handle, 'reading-position.json')
      st().selectPaper('p1')
      st().noteReadingPosition('p1', 3, 0)
      st().closeProject()

      st().loadFromText(project, handle, 'reading-position.json')
      expect(st().initialPdfPosition).toEqual({ paperId: 'p1', page: 3, offsetFraction: 0 })

      render(<PdfViewer />)
      // Let getPdfSource's promise and Document's onLoadSuccess settle —
      // every page mounts at PLACEHOLDER_HEIGHT, none have "rendered" yet.
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      // First scroll happens immediately once pages exist, while everything
      // is still placeholder-sized — this alone is what the pre-fix code
      // considered "done" (and cleared the request right after).
      expect(scrolledPageIndices()).toContain(2)
      // The request must still be pending — clearing here, before layout
      // has actually settled, is exactly the bug: nothing would re-snap
      // page 3 back into place once earlier pages grow.
      expect(st().initialPdfPosition).not.toBeNull()

      // Pages 1 and 2 (indices 0, 1) now finish rendering, growing from
      // PLACEHOLDER_HEIGHT to REAL_HEIGHT — in a real browser this is
      // exactly what shoves page 3 down and out from under the scroll
      // already applied.
      act(() => {
        renderedPages.add(0)
        textLayerCallbacks.get(1)?.()
      })
      act(() => {
        renderedPages.add(1)
        textLayerCallbacks.get(2)?.()
      })

      // The fix must have re-applied the scroll to page 3 again, after its
      // real position (now much further down) was known.
      const callsAfterGrowth = scrolledPageIndices().filter((i) => i === 2).length
      expect(callsAfterGrowth).toBeGreaterThan(1)
      expect(st().initialPdfPosition).not.toBeNull() // still settling

      // No further rendering activity — the one-shot request finally clears.
      await act(async () => {
        vi.advanceTimersByTime(900)
      })
      expect(st().initialPdfPosition).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('also restores the scroll offset within the target page, not just the page itself', async () => {
    st().loadFromText(project, handle, 'reading-position.json')
    st().selectPaper('p1')
    // Halfway down page 3.
    st().noteReadingPosition('p1', 3, 0.5)
    st().closeProject()

    st().loadFromText(project, handle, 'reading-position.json')
    expect(st().initialPdfPosition).toEqual({ paperId: 'p1', page: 3, offsetFraction: 0.5 })

    // Page 3 (index 2) already at its real height from the start, so the
    // offset applies against REAL_HEIGHT immediately — isolates this test
    // from the separate placeholder-growth re-snap behavior covered above.
    renderedPages.add(2)
    const { container } = render(<PdfViewer />)
    await flush()
    await flush()

    const root = container.querySelector('.pdf-scroll') as HTMLDivElement
    // `scrollIntoView` is mocked to a no-op above, so page 3's own
    // REAL_HEIGHT (already rendered, immediately, in this test's mock) is
    // the only thing left to move `scrollTop` — exactly the offset applied
    // on top of the plain page-level jump.
    expect(root.scrollTop).toBe(0.5 * REAL_HEIGHT)
  })

  it('does nothing when there is no remembered position', async () => {
    st().loadFromText(project, handle, 'no-position.json')
    expect(st().initialPdfPosition).toBeNull()

    render(<PdfViewer />)
    await flush()
    await flush()

    expect(scrollIntoViewSpy).not.toHaveBeenCalled()
  })
})
