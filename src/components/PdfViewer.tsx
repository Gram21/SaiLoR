import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Document, Page } from 'react-pdf'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import { useStore, selectCurrentPaper, PDF_ZOOM_MIN, PDF_ZOOM_MAX } from '../state/store'
import { MARK_COLORS, sortMarksForCycling, type MarkRect, type PdfMark } from '../model/pdfMarks'
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

/** Clamps a `position: fixed` popover anchored at `anchor` (a raw click point)
 *  into the viewport, the same two-pass measure-then-clamp approach as
 *  `NodeName`'s description popover: the first mount is unclamped so the
 *  popover's real size can be measured, then this effect (before paint,
 *  hence `useLayoutEffect` not `useEffect`) clamps it. */
function useClampedAnchor(ref: React.RefObject<HTMLDivElement | null>, anchor: { x: number; y: number } | null) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!anchor || !el) {
      setPos(null)
      return
    }
    const m = 8
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.min(Math.max(m, anchor.x), window.innerWidth - r.width - m),
      top: Math.min(Math.max(m, anchor.y), window.innerHeight - r.height - m),
    })
    // Deliberately just `[anchor]`, not `[anchor, pos]` — `pos` is what this
    // effect sets, so adding it as a dep would re-run on every clamp, which
    // re-measures the (unchanged) box and sets the same `pos` again forever.
  }, [anchor])
  return pos
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

  // PDF highlights/comments — the standard "select text, highlight it,
  // optionally attach a note" most PDF viewers offer. See `pdfMarks.ts` for
  // why these are SaiLoR's own overlay data rather than real PDF annotation
  // objects written into the file.
  const marks = useStore((s) => s.currentPdfMarks())
  const addHighlight = useStore((s) => s.addHighlight)
  const setMarkComment = useStore((s) => s.setMarkComment)
  const setMarkColor = useStore((s) => s.setMarkColor)
  const removeMark = useStore((s) => s.removeMark)
  const unlinkMarkFromField = useStore((s) => s.unlinkMarkFromField)
  const setExportPdfOpen = useStore((s) => s.setExportPdfOpen)
  // The color-swatch toolbar offered right after a text selection, positioned
  // near where the selection ends — the same "select, then a small popup
  // offers to highlight" flow Preview/Acrobat use.
  const [selectionToolbar, setSelectionToolbar] = useState<
    { x: number; y: number; page: number; rects: MarkRect[] } | null
  >(null)
  // The comment/color popover for one existing highlight, opened by clicking it
  // (or automatically right after creating one, so a note can be typed at once).
  const [activeMark, setActiveMark] = useState<{ id: string; x: number; y: number } | null>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const markPopoverRef = useRef<HTMLDivElement>(null)
  const toolbarPos = useClampedAnchor(toolbarRef, selectionToolbar)
  const markPopoverPos = useClampedAnchor(markPopoverRef, activeMark)

  // Annotation-tools row: sticky notes plus cycling through every mark.
  const [annotationToolbarOpen, setAnnotationToolbarOpen] = useState(false)
  const [placingNote, setPlacingNote] = useState(false)
  const [cycleIndex, setCycleIndex] = useState<number | null>(null)
  const [flashMarkId, setFlashMarkId] = useState<string | null>(null)
  const flashTimeoutRef = useRef<number | undefined>(undefined)
  const sortedMarks = useMemo(() => sortMarksForCycling(marks), [marks])

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
    setSelectionToolbar(null)
    setActiveMark(null)
    setPlacingNote(false)
    setCycleIndex(null)
    setFlashMarkId(null)
    if (flashTimeoutRef.current !== undefined) window.clearTimeout(flashTimeoutRef.current)
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

  // Clear a pending flash timeout when the viewer unmounts (the load effect
  // above already clears it on every paper change).
  useEffect(() => () => {
    if (flashTimeoutRef.current !== undefined) window.clearTimeout(flashTimeoutRef.current)
  }, [])

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
    // Popovers are fixed-position at a captured client point; scrolling invalidates it.
    setSelectionToolbar(null)
    setActiveMark(null)
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

  /** Scroll to a mark's actual position on its page (not just the page top),
   *  vertically centering it the same way the in-PDF search's active match is
   *  centered below. Falls back to `scrollToPage` if the page isn't rendered
   *  yet (shouldn't happen — every page is mounted, no virtualization). */
  const scrollToMark = (mark: PdfMark) => {
    const root = containerRef.current
    const pageEl = pageRefs.current[mark.page - 1]
    if (!root || !pageEl) {
      scrollToPage(mark.page)
      return
    }
    setCurrentPage(mark.page)
    const pageRect = pageEl.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const markTop = pageRect.top + (mark.rects[0]?.y ?? 0) * pageRect.height
    root.scrollTop += markTop - rootRect.top - root.clientHeight / 2
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
    updateSelectionToolbar(sel, text)
  }

  /** Which rendered page (1-indexed) `node` sits inside, by finding its
   *  closest `.react-pdf__Page` ancestor and matching it against `pageRefs`
   *  — the same elements the scroll-position tracking above already keys
   *  off, rather than trusting a pdf.js/react-pdf internal attribute. */
  const pageNumberForNode = (node: Node | null): number | null => {
    const el = node instanceof Element ? node : node?.parentElement ?? null
    const pageEl = el?.closest<HTMLElement>('.react-pdf__Page')
    if (!pageEl) return null
    const idx = pageRefs.current.indexOf(pageEl as HTMLDivElement)
    return idx === -1 ? null : idx + 1
  }

  /** Offers the highlight color toolbar for a real, single-page text
   *  selection; hides it otherwise (nothing selected, or a selection that
   *  somehow spans two pages — rare in a PDF text layer, and not worth
   *  supporting: a highlight is one page's own overlay). */
  const updateSelectionToolbar = (sel: Selection | null, text: string) => {
    if (!sel || sel.isCollapsed || !text.trim()) {
      setSelectionToolbar(null)
      return
    }
    const range = sel.getRangeAt(0)
    const startPage = pageNumberForNode(range.startContainer)
    const endPage = pageNumberForNode(range.endContainer)
    if (startPage === null || startPage !== endPage) {
      setSelectionToolbar(null)
      return
    }
    const pageEl = pageRefs.current[startPage - 1]
    if (!pageEl) {
      setSelectionToolbar(null)
      return
    }
    const pageRect = pageEl.getBoundingClientRect()
    const clientRects = Array.from(range.getClientRects())
    const rects: MarkRect[] = clientRects
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => ({
        x: (r.left - pageRect.left) / pageRect.width,
        y: (r.top - pageRect.top) / pageRect.height,
        width: r.width / pageRect.width,
        height: r.height / pageRect.height,
      }))
    if (rects.length === 0) {
      setSelectionToolbar(null)
      return
    }
    const anchor = clientRects[clientRects.length - 1] ?? range.getBoundingClientRect()
    setActiveMark(null)
    setSelectionToolbar({ x: anchor.right, y: anchor.bottom, page: startPage, rects })
  }

  /** Highlights the pending selection in `color`, closes the toolbar, and
   *  opens the new mark's comment popover right away so a note can be typed
   *  at once — the same flow as clicking an existing highlight. */
  const commitHighlight = (color: string) => {
    if (!selectionToolbar) return
    const { x, y, page, rects } = selectionToolbar
    const id = addHighlight(page, rects, color)
    setSelectionToolbar(null)
    window.getSelection()?.removeAllRanges()
    if (id) setActiveMark({ id, x, y })
  }

  /** Scroll to a mark and briefly pulse it — the shared "show me this one"
   *  action behind both cycling and a jump requested from elsewhere (the
   *  field-link popover). */
  const flashAndScrollTo = (mark: PdfMark) => {
    scrollToMark(mark)
    setFlashMarkId(mark.id)
    if (flashTimeoutRef.current !== undefined) window.clearTimeout(flashTimeoutRef.current)
    flashTimeoutRef.current = window.setTimeout(() => setFlashMarkId(null), 1500)
  }

  /** Advance the annotation-cycling cursor and flash the mark it lands on.
   *  `cycleIndex` starts `null` (nothing cycled to yet); the first Next/Prev
   *  then lands on the first/last mark respectively. */
  const cycleTo = (dir: 1 | -1) => {
    const total = sortedMarks.length
    if (total === 0) return
    const i = cycleIndex ?? (dir === 1 ? -1 : 0)
    const next = (i + dir + total) % total
    setCycleIndex(next)
    flashAndScrollTo(sortedMarks[next])
  }

  // A jump requested from elsewhere (the field-link popover's "show me this
  // mark" before linking it) — scroll to it and clear the request, leaving
  // whatever popover asked for it open (this never touches `activeMark`).
  const pendingMarkJump = useStore((s) => s.pendingMarkJump)
  const setPendingMarkJump = useStore((s) => s.setPendingMarkJump)
  useEffect(() => {
    if (!pendingMarkJump) return
    const mark = marks.find((m) => m.id === pendingMarkJump)
    if (mark) flashAndScrollTo(mark)
    setPendingMarkJump(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMarkJump])

  /** While `placingNote` is active, a plain click inside a page drops a
   *  sticky note at that point and opens its comment popover — one shot,
   *  same as `commitHighlight` does for a selection. */
  const placeNote = (e: React.MouseEvent) => {
    if (!placingNote) return
    const page = pageNumberForNode(e.target as Node)
    if (page === null) return
    const pageEl = pageRefs.current[page - 1]
    if (!pageEl) return
    const pageRect = pageEl.getBoundingClientRect()
    const x = (e.clientX - pageRect.left) / pageRect.width
    const y = (e.clientY - pageRect.top) / pageRect.height
    const id = addHighlight(page, [{ x, y, width: 0.02, height: 0.02 }], undefined, 'note')
    setPlacingNote(false)
    if (id) setActiveMark({ id, x: e.clientX, y: e.clientY })
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

  // Dismiss the highlight color toolbar / comment popover on Escape or a
  // mousedown outside both — checked by ancestry (`closest`) rather than
  // relying on the popovers' own `stopPropagation`, since that only affects
  // the later `click` event, not this earlier `mousedown` one.
  useEffect(() => {
    if (!selectionToolbar && !activeMark) return
    const dismiss = (e?: MouseEvent) => {
      if (e && (e.target as HTMLElement | null)?.closest('.pdf-highlight-toolbar, .pdf-mark-popover')) return
      setSelectionToolbar(null)
      setActiveMark(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [selectionToolbar, activeMark])

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
  // box, search-match highlight updates) reuse the same element references.
  // React then bails out of re-rendering the pages, keeping their text layers
  // stable. `marks` IS a real dependency — a reviewer's own highlights are
  // rendered as each page's `children` (react-pdf renders them after its own
  // canvas/text/annotation layers, inside the same `position: relative`
  // wrapper, so percentage-based positioning lines up for free) — but that
  // only re-renders the cheap overlay `<div>`s, never pdf.js's own rendering,
  // which is driven by `pageNumber`/`width` alone.
  const pages = useMemo(
    () =>
      Array.from({ length: numPages }, (_, i) => {
        const pageNumber = i + 1
        const pageMarks = marks.filter((m) => m.page === pageNumber)
        return (
          <Page
            key={i}
            pageNumber={pageNumber}
            width={renderWidth}
            inputRef={(el) => {
              pageRefs.current[i] = el
            }}
            renderTextLayer
            renderAnnotationLayer
            onRenderTextLayerSuccess={onTextLayerRendered}
          >
            {pageMarks.length > 0 && (
              <div className="pdf-marks-overlay">
                {pageMarks.map((mark) => {
                  const onOpen = (e: React.MouseEvent) => {
                    e.stopPropagation()
                    setSelectionToolbar(null)
                    setActiveMark({ id: mark.id, x: e.clientX, y: e.clientY })
                  }
                  const flash = flashMarkId === mark.id ? ' flash' : ''
                  if (mark.kind === 'note') {
                    return (
                      <div
                        key={mark.id}
                        className={`pdf-mark-note${flash}`}
                        style={{
                          left: `${mark.rects[0].x * 100}%`,
                          top: `${mark.rects[0].y * 100}%`,
                          backgroundColor: mark.color,
                        }}
                        title={mark.comment || undefined}
                        onClick={onOpen}
                      />
                    )
                  }
                  return (
                    <div key={mark.id}>
                      {mark.rects.map((r, ri) => (
                        <div
                          key={ri}
                          className={`pdf-mark-rect${flash}`}
                          style={{
                            left: `${r.x * 100}%`,
                            top: `${r.y * 100}%`,
                            width: `${r.width * 100}%`,
                            height: `${r.height * 100}%`,
                            background: mark.color,
                          }}
                          title={mark.comment || undefined}
                          onClick={onOpen}
                        />
                      ))}
                      {mark.comment && (
                        <div
                          className="pdf-mark-comment-dot"
                          style={{ left: `${mark.rects[0].x * 100}%`, top: `${mark.rects[0].y * 100}%` }}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Page>
        )
      }),
    [numPages, renderWidth, onTextLayerRendered, marks, flashMarkId],
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
            className={`icon-btn${annotationToolbarOpen ? ' active' : ''}`}
            title="Annotation tools"
            aria-label="Annotation tools"
            aria-pressed={annotationToolbarOpen}
            onClick={() =>
              setAnnotationToolbarOpen((open) => {
                if (open) setPlacingNote(false)
                return !open
              })
            }
          >
            📝
          </button>
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
      {annotationToolbarOpen && (
        <div className="pdf-annotation-toolbar" role="toolbar" aria-label="Annotation tools">
          <button
            type="button"
            className={`icon-btn${placingNote ? ' active' : ''}`}
            title="Add sticky note"
            aria-label="Add sticky note"
            aria-pressed={placingNote}
            onClick={() => setPlacingNote((v) => !v)}
          >
            <span className="postit-icon" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Previous annotation"
            aria-label="Previous annotation"
            onClick={() => cycleTo(-1)}
            disabled={sortedMarks.length === 0}
          >
            ‹
          </button>
          <span className="pdf-search-count">
            {sortedMarks.length === 0
              ? '0 / 0'
              : `${cycleIndex === null ? '–' : cycleIndex + 1} / ${sortedMarks.length}`}
          </span>
          <button
            type="button"
            className="icon-btn"
            title="Next annotation"
            aria-label="Next annotation"
            onClick={() => cycleTo(1)}
            disabled={sortedMarks.length === 0}
          >
            ›
          </button>
          <button
            type="button"
            className="icon-btn pdf-annotation-toolbar-export"
            title="Export PDF with annotations"
            aria-label="Export PDF with annotations"
            onClick={() => setExportPdfOpen(true)}
            disabled={marks.length === 0}
          >
            📤
          </button>
        </div>
      )}
      <div
        className={`pdf-scroll${placingNote ? ' placing-note' : ''}`}
        ref={containerRef}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        onScroll={updateCurrentPage}
        onClickCapture={onPdfClickCapture}
        onClick={placeNote}
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
      {selectionToolbar && (
        <div
          ref={toolbarRef}
          className="pdf-highlight-toolbar"
          style={
            toolbarPos
              ? { left: toolbarPos.left, top: toolbarPos.top }
              : { left: selectionToolbar.x, top: selectionToolbar.y, visibility: 'hidden' }
          }
          onClick={(e) => e.stopPropagation()}
        >
          {MARK_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className="pdf-color-swatch"
              style={{ background: c }}
              title="Highlight"
              aria-label={`Highlight in ${c}`}
              onClick={() => commitHighlight(c)}
            />
          ))}
        </div>
      )}
      {activeMark &&
        (() => {
          const mark = marks.find((m) => m.id === activeMark.id)
          if (!mark) return null
          return (
            <div
              ref={markPopoverRef}
              className="pdf-mark-popover"
              style={
                markPopoverPos
                  ? { left: markPopoverPos.left, top: markPopoverPos.top }
                  : { left: activeMark.x, top: activeMark.y, visibility: 'hidden' }
              }
              onClick={(e) => e.stopPropagation()}
            >
              <div className="pdf-mark-popover-colors">
                {MARK_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`pdf-color-swatch${mark.color === c ? ' active' : ''}`}
                    style={{ background: c }}
                    title="Recolor"
                    aria-label={`Set color ${c}`}
                    onClick={() => setMarkColor(mark.id, c)}
                  />
                ))}
              </div>
              <textarea
                className="field-input field-textarea pdf-mark-comment-input"
                placeholder="Add a comment…"
                value={mark.comment}
                autoFocus
                onChange={(e) => setMarkComment(mark.id, e.target.value)}
              />
              {mark.linkedFields && mark.linkedFields.length > 0 && (
                <ul className="pdf-mark-links">
                  {mark.linkedFields.map((l) => (
                    <li key={l.path}>
                      <span className="pdf-mark-link-label" title={l.label}>
                        {l.label}
                      </span>
                      <button
                        type="button"
                        className="field-link-unlink"
                        title="Unlink"
                        onClick={() => unlinkMarkFromField(mark.id, l.path)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="pdf-mark-popover-actions">
                <button
                  type="button"
                  className="pdf-mark-delete"
                  onClick={() => {
                    removeMark(mark.id)
                    setActiveMark(null)
                  }}
                >
                  Delete
                </button>
                <button type="button" className="primary" onClick={() => setActiveMark(null)}>
                  Done
                </button>
              </div>
            </div>
          )
        })()}
    </div>
  )
}
