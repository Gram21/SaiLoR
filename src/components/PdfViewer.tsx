import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Document, Page } from 'react-pdf'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import { useStore, selectCurrentPaper, PDF_ZOOM_MIN, PDF_ZOOM_MAX } from '../state/store'
import { getPlatform } from '../platform'
// Side-effect import: configures the pdf.js worker.
import '../platform/pdfjs'

// In-PDF search uses the CSS Custom Highlight API to tint matches without
// mutating react-pdf's text-layer DOM. Highlight/CSS.highlights aren't in the
// TS lib yet, so reach for them dynamically and degrade gracefully.
/**
 * The most pages this viewer will mount. There is no virtualization: every page
 * is a React element with its own canvas, text layer and annotation layer, plus
 * an entry in `pageRefs`. Real documents do not reach five figures, and a
 * hostile one can claim 16 million from 2.4 KB — see `onLoadSuccess`.
 */
const MAX_PDF_PAGES = 5000

const HL_NAME = 'slr-pdf-search'
const HL_NAME_ACTIVE = 'slr-pdf-search-active'
const highlightRegistry: Map<string, unknown> | undefined =
  typeof CSS !== 'undefined' ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined
const HighlightCtor: (new (...ranges: Range[]) => unknown) | undefined = (
  globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
).Highlight
const canHighlight = !!highlightRegistry && !!HighlightCtor

function clearHighlights() {
  highlightRegistry?.delete(HL_NAME)
  highlightRegistry?.delete(HL_NAME_ACTIVE)
}

/** Find all ranges matching `query` within each text layer under `root`. */
function findMatches(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = []
  const needle = query.toLowerCase()
  if (!needle) return ranges
  const layers = root.querySelectorAll<HTMLElement>('.react-pdf__Page__textContent')
  layers.forEach((layer) => {
    // Concatenate the layer's text nodes so matches can span multiple spans.
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    const starts: number[] = []
    let hay = ''
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      starts.push(hay.length)
      nodes.push(n as Text)
      hay += (n as Text).data
    }
    const lower = hay.toLowerCase()
    const locate = (offset: number): { node: Text; offset: number } | null => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (starts[i] <= offset) return { node: nodes[i], offset: offset - starts[i] }
      }
      return null
    }
    let idx = lower.indexOf(needle)
    while (idx !== -1) {
      const start = locate(idx)
      const end = locate(idx + needle.length)
      if (start && end) {
        const range = document.createRange()
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset)
        ranges.push(range)
      }
      idx = lower.indexOf(needle, idx + needle.length)
    }
  })
  return ranges
}

/** Middle pane: renders the current paper's PDF and captures text selection. */
export function PdfViewer() {
  // Subscribe to primitive fields only. Subscribing to the whole paper object
  // would re-run the load effect on every annotation edit (immer returns a new
  // paper object), which would reload — and briefly blank — the PDF.
  const paperId = useStore((s) => selectCurrentPaper(s)?.id ?? null)
  const pdfPath = useStore((s) => selectCurrentPaper(s)?.pdf ?? null)
  const title = useStore((s) => selectCurrentPaper(s)?.title ?? '')
  const authors = useStore((s) => (selectCurrentPaper(s)?.authors ?? []).join(', '))
  const doi = useStore((s) => selectCurrentPaper(s)?.doi)
  const saveHandle = useStore((s) => s.saveHandle)
  const setPdfSelection = useStore((s) => s.setPdfSelection)
  const screening = useStore((s) => s.project?.screening != null)
  const toggleScreeningPdf = useStore((s) => s.toggleScreeningPdf)

  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsFolderGrant, setNeedsFolderGrant] = useState(false)
  const [grantingFolder, setGrantingFolder] = useState(false)
  const [numPages, setNumPages] = useState(0)
  /** The document's real page count when it exceeded `MAX_PDF_PAGES`, else 0. */
  const [truncatedPages, setTruncatedPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [width, setWidth] = useState(600)
  const containerRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<(HTMLDivElement | null)[]>([])
  const pageInputRef = useRef<HTMLInputElement>(null)
  const revokeRef = useRef<(() => void) | undefined>(undefined)
  // Which paper is on screen right now, readable from a callback that was
  // created for a different one — see `grantFolderAccess`.
  const paperIdRef = useRef(paperId)
  paperIdRef.current = paperId

  // In-PDF search.
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [activeMatch, setActiveMatch] = useState(0)
  const [textRenderTick, setTextRenderTick] = useState(0)
  const matchesRef = useRef<Range[]>([])
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Jump history (back/forward for in-PDF link jumps). Scroll positions before a
  // link jump go on the back stack; back/forward move between them like a browser.
  const backStackRef = useRef<number[]>([])
  const forwardStackRef = useRef<number[]>([])
  const [canJumpBack, setCanJumpBack] = useState(false)
  const [canJumpForward, setCanJumpForward] = useState(false)
  const syncJumpNav = () => {
    setCanJumpBack(backStackRef.current.length > 0)
    setCanJumpForward(forwardStackRef.current.length > 0)
  }

  // PDF zoom lives in the store so keyboard shortcuts (Ctrl +/-) can drive it too.
  const zoom = useStore((s) => s.pdfZoom)
  const zoomIn = useStore((s) => s.zoomInPdf)
  const zoomOut = useStore((s) => s.zoomOutPdf)
  const resetZoom = useStore((s) => s.resetPdfZoom)
  // The page renders at the fit-to-width base size scaled by the zoom factor.
  const renderWidth = Math.round(width * zoom)

  // Resolve the PDF source only when the paper identity or its pdf path changes.
  useEffect(() => {
    let cancelled = false
    setError(null)
    setNeedsFolderGrant(false)
    setNumPages(0)
    setTruncatedPages(0)
    setCurrentPage(1)
    setPageInput('1')
    pageRefs.current = []
    backStackRef.current = []
    forwardStackRef.current = []
    setCanJumpBack(false)
    setCanJumpForward(false)
    setUrl(null)
    revokeRef.current?.()
    revokeRef.current = undefined
    if (!pdfPath) return

    // A locally opened browser project needs a one-time folder grant before
    // any of its PDFs can be read. Ask for it explicitly — a button below,
    // driven by a real click — rather than let getPdfSource pop the native
    // picker unannounced the moment a paper is first opened, which reads as
    // the app doing something on its own for no visible reason (and, on
    // Firefox, opens with the browser's own "upload files?" framing, which
    // is alarming to see with no context).
    if (getPlatform().needsPdfFolderGrant()) {
      setNeedsFolderGrant(true)
      return
    }
    getPlatform()
      .getPdfSource(pdfPath, saveHandle ?? { kind: 'download' })
      .then((src) => {
        if (cancelled) {
          src.revoke?.()
          return
        }
        revokeRef.current = src.revoke
        setUrl(src.url)
      })
      .catch((err) => !cancelled && setError(String(err?.message ?? err)))
    return () => {
      cancelled = true
    }
  }, [paperId, pdfPath, saveHandle])

  // Revoke the last object URL when the viewer itself unmounts (the effect
  // above already revokes on every paper/handle change, via revokeRef).
  useEffect(() => () => revokeRef.current?.(), [])

  // The explicit "Choose folder…" action: a real click, so the native picker
  // is guaranteed to open (some browsers refuse it otherwise) and the
  // reviewer sees why they're being asked before the OS dialog appears.
  const grantFolderAccess = () => {
    if (!pdfPath) return
    setGrantingFolder(true)
    setError(null)
    getPlatform()
      .grantPdfFolderAccess()
      .then(() => {
        setNeedsFolderGrant(false)
        return getPlatform().getPdfSource(pdfPath, saveHandle ?? { kind: 'download' })
      })
      .then((src) => {
        // The same guard the load effect has, for the same reason. Granting the
        // folder makes the page interactive again while the directory walk and
        // the PDF read are still in flight, so the reviewer can select another
        // paper meanwhile — and the load effect then starts its own fetch,
        // since the grant it was waiting for has arrived. Whichever settled
        // last used to win, which could leave paper B selected in the list and
        // the annotation panel with paper A's PDF on screen: annotating one
        // paper from another's text, with nothing to show anything was wrong.
        if (paperIdRef.current !== paperId) {
          src.revoke?.()
          return
        }
        revokeRef.current?.()
        revokeRef.current = src.revoke
        setUrl(src.url)
      })
      .catch((err) => paperIdRef.current === paperId && setError(String(err?.message ?? err)))
      .finally(() => setGrantingFolder(false))
  }

  // Track container width so pages scale to fit.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 600
      setWidth(Math.max(240, Math.floor(w - 24)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Update the "current page" from the scroll position: the last page whose top
  // has scrolled into the upper part of the viewport. Runs on every scroll, so
  // it also reflects jumps made by internal PDF links.
  const updateCurrentPage = () => {
    const root = containerRef.current
    if (!root) return
    const rootTop = root.getBoundingClientRect().top
    const threshold = root.clientHeight * 0.3
    let cur = 1
    for (let i = 0; i < pageRefs.current.length; i++) {
      const el = pageRefs.current[i]
      if (el && el.getBoundingClientRect().top - rootTop <= threshold) cur = i + 1
    }
    setCurrentPage(cur)
  }

  // Keep the page input in sync with the current page (unless the user is editing it).
  useEffect(() => {
    if (document.activeElement !== pageInputRef.current) setPageInput(String(currentPage))
  }, [currentPage])

  const scrollToPage = (n: number) => {
    const count = pageRefs.current.length
    if (count === 0) return
    const clamped = Math.min(Math.max(1, n), count)
    setCurrentPage(clamped)
    pageRefs.current[clamped - 1]?.scrollIntoView({ block: 'start' })
  }

  // Commit a typed page number: clamp to [1, numPages] and jump there.
  const commitPageInput = () => {
    const n = parseInt(pageInput, 10)
    if (Number.isNaN(n)) {
      setPageInput(String(currentPage))
      return
    }
    const clamped = Math.min(Math.max(1, n), Math.max(1, numPages))
    setPageInput(String(clamped))
    scrollToPage(clamped)
  }

  // Capture the current text selection inside the viewer.
  const captureSelection = () => {
    const sel = window.getSelection()
    const text = sel?.toString() ?? ''
    if (text.trim()) setPdfSelection(text)
  }

  // When an in-PDF link is clicked, the pdf.js LinkService scrolls to the
  // destination. We record the position we jumped *from* so the user can get
  // back. The scroll happens asynchronously after the click, so poll briefly and
  // only record if the view actually moved (ignores external links, which don't).
  const JUMP_THRESHOLD = 24
  const recordJumpIfMoved = (from: number) => {
    let tries = 0
    const check = () => {
      const root = containerRef.current
      if (!root) return
      if (Math.abs(root.scrollTop - from) > JUMP_THRESHOLD) {
        backStackRef.current.push(from)
        forwardStackRef.current = []
        syncJumpNav()
      } else if (tries++ < 8) {
        window.setTimeout(check, 40)
      }
    }
    window.setTimeout(check, 40)
  }

  const onPdfClickCapture = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement | null
    if (!el?.closest('a')) return
    const root = containerRef.current
    if (root) recordJumpIfMoved(root.scrollTop)
  }

  const jumpBack = () => {
    const root = containerRef.current
    if (!root || backStackRef.current.length === 0) return
    const target = backStackRef.current.pop() as number
    forwardStackRef.current.push(root.scrollTop)
    // Instant scroll (matches the link jump, and works with reduced-motion).
    root.scrollTo({ top: target })
    syncJumpNav()
  }

  const jumpForward = () => {
    const root = containerRef.current
    if (!root || forwardStackRef.current.length === 0) return
    const target = forwardStackRef.current.pop() as number
    backStackRef.current.push(root.scrollTop)
    root.scrollTo({ top: target })
    syncJumpNav()
  }

  const focusSearchInput = () => {
    const el = searchInputRef.current
    if (!el) return
    el.focus()
    el.select()
  }

  const openSearch = () => {
    // If already open, focus now; the effect below covers the just-opened case
    // (the input isn't mounted yet on the open transition).
    setSearchOpen(true)
    focusSearchInput()
  }

  // Focus the search field once it mounts on open, so the user can type at once.
  useEffect(() => {
    if (searchOpen) focusSearchInput()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen])

  const closeSearch = () => {
    setSearchOpen(false)
    clearHighlights()
  }

  const goToMatch = (dir: 1 | -1) => {
    const n = matchesRef.current.length
    if (n === 0) return
    setActiveMatch((prev) => (prev + dir + n) % n)
  }

  // Ctrl/Cmd+F opens the search bar and focuses it (overriding the browser find).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        openSearch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Clear highlights when the viewer unmounts.
  useEffect(() => clearHighlights, [])

  // (Re)compute matches when the query, page set, or a text layer finishes
  // rendering changes. Recomputes against text layers already in the DOM.
  useEffect(() => {
    if (!searchOpen || !query) {
      matchesRef.current = []
      setMatchCount(0)
      setActiveMatch(0)
      clearHighlights()
      return
    }
    const root = containerRef.current
    const ranges = root ? findMatches(root, query) : []
    matchesRef.current = ranges
    setMatchCount(ranges.length)
    setActiveMatch((prev) => (ranges.length ? Math.min(prev, ranges.length - 1) : 0))
  }, [query, searchOpen, numPages, textRenderTick])

  // Stable callback so the memoized pages below don't change identity (which
  // would tear down and re-render the text layers on every search keystroke).
  const onTextLayerRendered = useCallback(() => setTextRenderTick((t) => t + 1), [])

  // Memoize the page elements so unrelated re-renders (typing in the search
  // box, highlight updates) reuse the same element references. React then bails
  // out of re-rendering the pages, keeping their text layers stable.
  const pages = useMemo(
    () =>
      Array.from({ length: numPages }, (_, i) => (
        <Page
          key={i}
          pageNumber={i + 1}
          width={renderWidth}
          inputRef={(el) => {
            pageRefs.current[i] = el
          }}
          renderTextLayer
          renderAnnotationLayer
          onRenderTextLayerSuccess={onTextLayerRendered}
        />
      )),
    [numPages, renderWidth, onTextLayerRendered],
  )

  // Paint the highlights and scroll the active match into view.
  useEffect(() => {
    const ranges = matchesRef.current
    if (!searchOpen || ranges.length === 0) {
      clearHighlights()
      return
    }
    if (canHighlight && HighlightCtor && highlightRegistry) {
      const others = ranges.filter((_, i) => i !== activeMatch)
      highlightRegistry.set(HL_NAME, new HighlightCtor(...others))
      const active = ranges[activeMatch]
      highlightRegistry.set(HL_NAME_ACTIVE, active ? new HighlightCtor(active) : new HighlightCtor())
    }
    // Center the active match within the scroll container.
    const active = ranges[activeMatch]
    const root = containerRef.current
    if (active && root) {
      const rect = active.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      if (rect.height > 0) {
        root.scrollTop += rect.top - rootRect.top - root.clientHeight / 2
      }
    }
  }, [matchCount, activeMatch, searchOpen])

  if (!paperId) {
    return <div className="panel pdf empty">No paper selected.</div>
  }

  // Reachable now that a screening project may relax `pdf` to `""` — a
  // non-screening project's `pdf` is still required (`model/schema.ts`), so
  // this was unreachable before that relaxation existed.
  if (!pdfPath) {
    return (
      <div className="panel pdf empty">
        <div>
          This paper has no PDF attached.
          {screening && (
            <>
              {' '}
              <button type="button" onClick={toggleScreeningPdf}>
                Back to the record
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="panel pdf">
      <div className="pdf-head">
        <div className="pdf-meta">
          <span className="pdf-title">{title}</span>
          {authors && <span className="pdf-authors">{authors}</span>}
          {doi && (
            <span className="pdf-doi">
              DOI: <code>{doi}</code>
            </span>
          )}
        </div>
        <div className="pdf-tools">
          {screening && (
            <button type="button" onClick={toggleScreeningPdf}>
              Back to the record
            </button>
          )}
          {(canJumpBack || canJumpForward) && (
            <div className="pdf-history" role="group" aria-label="Jump history">
              <button
                type="button"
                className="icon-btn"
                title="Jump back to where you were before following a link"
                aria-label="Jump back"
                onClick={jumpBack}
                disabled={!canJumpBack}
              >
                ↩
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Jump forward"
                aria-label="Jump forward"
                onClick={jumpForward}
                disabled={!canJumpForward}
              >
                ↪
              </button>
            </div>
          )}
          {numPages > 1 && (
            <div className="pdf-pages" role="group" aria-label="Page navigation">
              <button
                type="button"
                className="icon-btn"
                title="Previous page"
                aria-label="Previous page"
                onClick={() => scrollToPage(currentPage - 1)}
                disabled={currentPage <= 1}
              >
                ‹
              </button>
              <input
                ref={pageInputRef}
                className="pdf-page-input"
                type="text"
                inputMode="numeric"
                aria-label="Current page"
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={commitPageInput}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitPageInput()
                    e.currentTarget.blur()
                  }
                }}
              />
              <span
                className="pdf-page-total"
                title={
                  truncatedPages
                    ? `This document reports ${truncatedPages} pages; only the first ${numPages} are shown.`
                    : undefined
                }
              >
                / {numPages}
                {truncatedPages ? '+' : ''}
              </span>
              <button
                type="button"
                className="icon-btn"
                title="Next page"
                aria-label="Next page"
                onClick={() => scrollToPage(currentPage + 1)}
                disabled={currentPage >= numPages}
              >
                ›
              </button>
            </div>
          )}
          <button
            type="button"
            className={`icon-btn${searchOpen ? ' active' : ''}`}
            title="Search in PDF (Ctrl+F)"
            aria-label="Search in PDF"
            aria-pressed={searchOpen}
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
          >
            🔍
          </button>
          <div className="pdf-zoom" role="group" aria-label="Zoom">
            <button
              type="button"
              className="icon-btn"
              title="Zoom out (Ctrl+-)"
              aria-label="Zoom out"
              onClick={zoomOut}
              disabled={zoom <= PDF_ZOOM_MIN}
            >
              −
            </button>
            <button
              type="button"
              className="icon-btn pdf-zoom-level"
              title="Reset zoom"
              aria-label="Reset zoom"
              onClick={resetZoom}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Zoom in (Ctrl++)"
              aria-label="Zoom in"
              onClick={zoomIn}
              disabled={zoom >= PDF_ZOOM_MAX}
            >
              +
            </button>
          </div>
        </div>
      </div>
      {searchOpen && (
        <div className="pdf-search" role="search">
          <input
            ref={searchInputRef}
            className="pdf-search-input"
            type="text"
            placeholder="Search in PDF…"
            aria-label="Search in PDF"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveMatch(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                goToMatch(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeSearch()
              }
            }}
          />
          <span className="pdf-search-count">
            {query ? (matchCount ? `${activeMatch + 1} / ${matchCount}` : '0 / 0') : ''}
          </span>
          <button
            type="button"
            className="icon-btn"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            onClick={() => goToMatch(-1)}
            disabled={matchCount === 0}
          >
            ‹
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Next match (Enter)"
            aria-label="Next match"
            onClick={() => goToMatch(1)}
            disabled={matchCount === 0}
          >
            ›
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Close search (Esc)"
            aria-label="Close search"
            onClick={closeSearch}
          >
            ×
          </button>
        </div>
      )}
      <div
        className="pdf-scroll"
        ref={containerRef}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        onScroll={updateCurrentPage}
        onClickCapture={onPdfClickCapture}
      >
        {error ? (
          <div className="pdf-error">Could not load PDF: {error}</div>
        ) : needsFolderGrant ? (
          <div className="pdf-grant">
            <p>
              SaiLoR needs to know where this project's PDFs are. Choose the folder that contains
              the project file — nothing is uploaded anywhere; it stays on this device.
            </p>
            <button
              type="button"
              className="primary"
              onClick={grantFolderAccess}
              disabled={grantingFolder}
            >
              {grantingFolder ? 'Waiting for folder…' : 'Choose folder…'}
            </button>
          </div>
        ) : url ? (
          <Document
            file={url}
            onLoadSuccess={(doc) => {
              // Cap what we agree to mount. pdf.js correctly ignores a lying
              // /Count, but it does not dedupe a page tree that is a DAG: a
              // 2.4 KB file whose /Pages nodes each list the same child twice,
              // 24 levels deep, reports 16 777 216 pages. There is no
              // virtualization here, so every page becomes a React element with
              // a canvas and a text layer — building the element array alone
              // measured 3.6 s and 3.6 GB at that count, which is a certain
              // renderer crash from clicking a paper. Real documents do not
              // reach five figures.
              setNumPages(Math.min(doc.numPages, MAX_PDF_PAGES))
              setTruncatedPages(doc.numPages > MAX_PDF_PAGES ? doc.numPages : 0)
            }}
            onLoadError={(err) => setError(String(err?.message ?? err))}
            loading={<div className="pdf-loading">Loading PDF…</div>}
            // External links open in a new browser tab instead of navigating the
            // app away. In Electron, the main process turns this into a system
            // browser open (setWindowOpenHandler). Internal links are unaffected —
            // pdf.js's LinkService scrolls to the destination without navigating.
            externalLinkTarget="_blank"
            externalLinkRel="noopener noreferrer"
          >
            {pages}
          </Document>
        ) : (
          <div className="pdf-loading">Loading PDF…</div>
        )}
      </div>
    </div>
  )
}
