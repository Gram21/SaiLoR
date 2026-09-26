import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Document, Page } from 'react-pdf'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import { useStore, selectCurrentPaper, PDF_ZOOM_MIN, PDF_ZOOM_MAX } from '../state/store'
import { MARK_COLORS, sortMarksForCycling, type MarkRect, type PdfMark } from '../model/pdfMarks'
import { screeningSeatLabel } from '../model/screeningMarks'
import { detectEntryBox, detectNumericCitation, findNumericReference, type PreviewTextItem } from '../model/refPreview'
import { getPlatform } from '../platform'
// Side-effect import: configures the pdf.js worker.
import '../platform/pdfjs'

// In-PDF search uses the CSS Custom Highlight API to tint matches without
// mutating react-pdf's text-layer DOM. Not in the TS lib yet, so reach for
// it dynamically and degrade gracefully.
/**
 * Page cap: no virtualization, every page becomes its own canvas/text/annotation
 * layer, and a hostile PDF can claim millions of pages from a tiny file — see
 * `onLoadSuccess`.
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

/**
 * Whether a mark's rect already sits inside the scroll container's visible
 * band. Pure (no DOM reads) so it's unit-testable; `pageRect`/`rootRect` are
 * `getBoundingClientRect()` results passed in by the caller.
 */
export function markVerticallyVisible(mark: PdfMark, pageRect: DOMRect, rootRect: DOMRect): boolean {
  const rect = mark.rects[0]
  if (!rect) return false
  const top = pageRect.top + rect.y * pageRect.height
  const bottom = top + rect.height * pageRect.height
  return top >= rootRect.top && bottom <= rootRect.bottom
}

/** Fraction of `b`'s area overlapping `a` — catches near-duplicate rects
 *  without flagging rects that merely sit side by side (overlap ~0). */
function overlapRatio(a: MarkRect, b: MarkRect): number {
  const left = Math.max(a.x, b.x)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const top = Math.max(a.y, b.y)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= left || bottom <= top) return 0
  const area = b.width * b.height
  return area > 0 ? ((right - left) * (bottom - top)) / area : 0
}

/**
 * `Range.getClientRects()` can report the same visual line twice (a
 * cross-browser quirk, not a pdf.js bug), which would render as a double-
 * opacity "marked twice" line. Rects that substantially overlap are folded
 * into their union; rects merely side by side on the same line (~0 overlap)
 * are left alone.
 */
export function dedupeOverlappingRects(rects: MarkRect[]): MarkRect[] {
  const out: MarkRect[] = []
  for (const r of rects) {
    const i = out.findIndex((o) => overlapRatio(o, r) > 0.6 || overlapRatio(r, o) > 0.6)
    if (i === -1) {
      out.push(r)
      continue
    }
    const o = out[i]
    const left = Math.min(o.x, r.x)
    const top = Math.min(o.y, r.y)
    const right = Math.max(o.x + o.width, r.x + r.width)
    const bottom = Math.max(o.y + o.height, r.y + r.height)
    out[i] = { x: left, y: top, width: right - left, height: bottom - top }
  }
  return out
}

/** Find all ranges matching `query` within each text layer under `root`.
 *  Case-insensitive unless `caseSensitive` is set. */
function findMatches(root: HTMLElement, query: string, caseSensitive: boolean): Range[] {
  const ranges: Range[] = []
  const needle = caseSensitive ? query : query.toLowerCase()
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
    const lower = caseSensitive ? hay : hay.toLowerCase()
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

/** Clamps a `position: fixed` popover anchored at a raw click point into the
 *  viewport. Two-pass: first mount is unclamped so the popover's real size
 *  can be measured, then `useLayoutEffect` (before paint) clamps it. */
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
    // Deliberately just `[anchor]`: adding `pos` (which this effect sets)
    // would re-trigger on every clamp, looping forever.
  }, [anchor])
  return pos
}

/** Where a mark's hover tooltip should render, flipping up when there's no
 *  room below — computed from whichever rect the mouse is actually over. */
function markTooltipCoords(el: HTMLElement): { x: number; top?: number; bottom?: number } {
  const r = el.getBoundingClientRect()
  const spaceBelow = window.innerHeight - r.bottom
  const openUp = spaceBelow < 100 && r.top > spaceBelow
  return openUp ? { x: r.left, bottom: window.innerHeight - r.top + 6 } : { x: r.left, top: r.bottom + 6 }
}

/** The x/y a PDF explicit destination points at, in PDF user space; `null`
 *  for each axis the destination kind leaves unspecified. Exported for its
 *  unit test — the rest of the link-preview flow needs a live pdf.js doc. */
export function destinationPoint(dest: unknown[]): { x: number | null; y: number | null } {
  const kind = (dest[1] as { name?: string } | null | undefined)?.name
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
  switch (kind) {
    case 'XYZ':
      return { x: num(dest[2]), y: num(dest[3]) }
    case 'FitH':
    case 'FitBH':
      return { x: null, y: num(dest[2]) }
    case 'FitV':
    case 'FitBV':
      return { x: num(dest[2]), y: null }
    case 'FitR':
      // [ref, {FitR}, x1, y1, x2, y2] — anchor at the rectangle's top-left.
      return { x: num(dest[2]), y: num(dest[5]) }
    default:
      return { x: null, y: null }
  }
}

/** On-screen size cap (CSS px) for the internal-link hover preview. The crop
 *  is scaled down, never clipped, so a wide reference entry stays whole. */
const LINK_PREVIEW_MAX_W = 560
const LINK_PREVIEW_MAX_H = 240

type LinkPreviewImage = { img: string; width: number; height: number }

/** The subset of a mouse event `onOpen` needs — not `React.MouseEvent`,
 *  since `handleMarkMouseDown` also calls it from a plain native
 *  `MouseEvent` (a `document`-level listener), and both satisfy this shape. */
type MarkOpenEvent = { clientX: number; clientY: number; stopPropagation: () => void }

/** One mark's rendered overlay plus its hover tooltip — split out of the
 *  memoized `pages` array so its own hover state doesn't force every page
 *  to re-render. */
function MarkOverlayItem({
  mark,
  flash,
  onOpen,
  onMarkMouseDown,
  from,
}: {
  mark: PdfMark
  flash: string
  onOpen: (e: MarkOpenEvent) => void
  /** See `handleMarkMouseDown` — replaces plain `onClick` so a drag starting
   *  here can anchor a real text selection instead of grabbing the overlay div. */
  onMarkMouseDown: (e: React.MouseEvent<HTMLElement>, onOpen: (e: MarkOpenEvent) => void) => void
  /** Another project's highlight, shown read-only: who made it. */
  from?: string
}) {
  const [coords, setCoords] = useState<{ x: number; top?: number; bottom?: number } | null>(null)
  const hasInfo = !!(from || mark.comment || mark.text || (mark.linkedFields && mark.linkedFields.length > 0))
  const extra = from ? ' is-foreign' : ''
  const show = (e: React.MouseEvent<HTMLElement>) => {
    if (hasInfo) setCoords(markTooltipCoords(e.currentTarget))
  }
  const hide = () => setCoords(null)

  const tooltip = coords && (
    <div
      className="tip pdf-mark-tooltip"
      role="tooltip"
      style={{
        left: coords.x,
        ...(coords.top !== undefined ? { top: coords.top } : { bottom: coords.bottom }),
      }}
    >
      {from && <p className="pdf-mark-tooltip-from">{from}</p>}
      {(mark.comment || mark.text) && <p className="pdf-mark-tooltip-text">{mark.comment || mark.text}</p>}
      {mark.linkedFields && mark.linkedFields.length > 0 && (
        <ul className="pdf-mark-tooltip-links">
          {mark.linkedFields.map((l) => (
            <li key={l.path}>🔗 {l.label}</li>
          ))}
        </ul>
      )}
    </div>
  )

  if (mark.kind === 'note') {
    return (
      <>
        <div
          className={`pdf-mark-note${flash}${extra}`}
          style={{
            left: `${mark.rects[0].x * 100}%`,
            top: `${mark.rects[0].y * 100}%`,
            backgroundColor: mark.color,
          }}
          onMouseDown={(e) => onMarkMouseDown(e, onOpen)}
          onMouseEnter={show}
          onMouseLeave={hide}
        />
        {tooltip && createPortal(tooltip, document.body)}
      </>
    )
  }

  return (
    <div>
      {mark.rects.map((r, ri) => (
        <div
          key={ri}
          className={`pdf-mark-rect${flash}${extra}`}
          style={{
            left: `${r.x * 100}%`,
            top: `${r.y * 100}%`,
            width: `${r.width * 100}%`,
            height: `${r.height * 100}%`,
            background: mark.color,
          }}
          onMouseDown={(e) => onMarkMouseDown(e, onOpen)}
          onMouseEnter={show}
          onMouseLeave={hide}
        />
      ))}
      {mark.comment && (
        <div
          className="pdf-mark-comment-dot"
          style={{ left: `${mark.rects[0].x * 100}%`, top: `${mark.rects[0].y * 100}%` }}
          aria-hidden="true"
        />
      )}
      {tooltip && createPortal(tooltip, document.body)}
    </div>
  )
}

/** Middle pane: renders the current paper's PDF and captures text selection. */
export function PdfViewer() {
  // Subscribe to primitive fields only — the whole paper object changes
  // identity on every annotation edit (immer), which would re-trigger the
  // load effect and briefly blank the PDF.
  const paperId = useStore((s) => selectCurrentPaper(s)?.id ?? null)
  const pdfPath = useStore((s) => selectCurrentPaper(s)?.pdf ?? null)
  const title = useStore((s) => selectCurrentPaper(s)?.title ?? '')
  const authors = useStore((s) => (selectCurrentPaper(s)?.authors ?? []).join(', '))
  const doi = useStore((s) => selectCurrentPaper(s)?.doi)
  const saveHandle = useStore((s) => s.saveHandle)
  // "Continue where you left off": paper/page to land on after a project
  // opens (populated by `loadFromText`), plus the write side that keeps it
  // current as the reviewer scrolls.
  const initialPdfPosition = useStore((s) => s.initialPdfPosition)
  const clearInitialPdfPosition = useStore((s) => s.clearInitialPdfPosition)
  const noteReadingPosition = useStore((s) => s.noteReadingPosition)
  const setPdfSelection = useStore((s) => s.setPdfSelection)
  const screening = useStore((s) => s.project?.screening != null)
  const toggleScreeningPdf = useStore((s) => s.toggleScreeningPdf)

  // PDF highlights/comments. See `pdfMarks.ts` for why these are SaiLoR's
  // own overlay data rather than real PDF annotation objects.
  const marks = useStore((s) => s.currentPdfMarks())
  // The screeners' highlights, read-only, when asked for — see `ScreeningMark`.
  const screeningMarks = useStore((s) => (s.showScreeningMarks && paperId ? s.screeningMarks?.[paperId] : undefined))
  const addHighlight = useStore((s) => s.addHighlight)
  const setMarkComment = useStore((s) => s.setMarkComment)
  const setMarkColor = useStore((s) => s.setMarkColor)
  const removeMark = useStore((s) => s.removeMark)
  const unlinkMarkFromField = useStore((s) => s.unlinkMarkFromField)
  const setExportPdfOpen = useStore((s) => s.setExportPdfOpen)
  const setLastCreatedMarkId = useStore((s) => s.setLastCreatedMarkId)
  // Color-swatch toolbar offered after a text selection, near where it ends.
  const [selectionToolbar, setSelectionToolbar] = useState<
    { x: number; y: number; spans: { page: number; rects: MarkRect[] }[]; text: string } | null
  >(null)
  // The comment/color popover for one existing highlight, opened by clicking it
  // (or automatically right after creating one, so a note can be typed at once).
  const [activeMark, setActiveMark] = useState<{ id: string; x: number; y: number } | null>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const markPopoverRef = useRef<HTMLDivElement>(null)
  const toolbarPos = useClampedAnchor(toolbarRef, selectionToolbar)
  const markPopoverPos = useClampedAnchor(markPopoverRef, activeMark)
  // True for the span of a mousedown-to-mouseup gesture that started on a
  // mark and turned into a drag — see `handleMarkMouseDown`. Adds
  // `.pdf-marks-dragging`, which lets the drag's mousemoves reach the text
  // layer underneath the mark.
  const [markDragActive, setMarkDragActive] = useState(false)

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
  // Which paper is on screen now, readable from a callback created for a
  // different one — see `grantFolderAccess`.
  const paperIdRef = useRef(paperId)
  paperIdRef.current = paperId

  // In-PDF search.
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  // `findMatches` walks every page's text layer — real work for a long
  // document, so debounce it; the input still reflects `query` immediately.
  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 150)
    return () => window.clearTimeout(t)
  }, [query])
  const [matchCount, setMatchCount] = useState(0)
  const [activeMatch, setActiveMatch] = useState(0)
  const [textRenderTick, setTextRenderTick] = useState(0)
  const matchesRef = useRef<Range[]>([])
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Reference hovering: hovering an internal PDF link previews its
  // destination, copied from that page's already-rendered canvas (every
  // page is mounted) so no extra pdf.js render is needed.
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  const linkHoverTokenRef = useRef(0)
  // Plain-text "[N]" citations (PDFs without link annotations): the hovered
  // citation's identity, so mousemove only re-resolves when it changes, and
  // each reference number's resolved entry location (null = not found) for
  // the current document.
  const citeHoverRef = useRef<string | null>(null)
  const citeLookupRef = useRef<{ doc: PDFDocumentProxy; found: Map<number, { page: number; x: number; y: number } | null> } | null>(null)
  const [linkPreview, setLinkPreview] = useState<{
    left: number
    top?: number
    bottom?: number
    img: string
    width: number
    height: number
  } | null>(null)
  const hideLinkPreview = () => {
    linkHoverTokenRef.current++ // invalidates any in-flight resolution too
    citeHoverRef.current = null
    setLinkPreview(null)
  }

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
    pdfDocRef.current = null
    hideLinkPreview()
    if (flashTimeoutRef.current !== undefined) window.clearTimeout(flashTimeoutRef.current)
    revokeRef.current?.()
    revokeRef.current = undefined
    // A pending "land on this page" request belongs to whichever paper it
    // was computed for — drop it if the reviewer switched papers before it
    // was reached. Read fresh so this effect doesn't need it as a dependency.
    const pending = useStore.getState().initialPdfPosition
    if (pending && pending.paperId !== paperId) clearInitialPdfPosition()
    if (!pdfPath) return

    // A locally opened browser project needs a one-time folder grant before
    // its PDFs can be read. Require an explicit button click rather than
    // popping the native picker unannounced (alarming, especially on Firefox).
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
  }, [paperId, pdfPath, saveHandle, clearInitialPdfPosition])

  // Revoke the last object URL when the viewer itself unmounts (the effect
  // above already revokes on every paper/handle change, via revokeRef).
  useEffect(() => () => revokeRef.current?.(), [])

  // Clear a pending flash timeout when the viewer unmounts (the load effect
  // above already clears it on every paper change).
  useEffect(() => () => {
    if (flashTimeoutRef.current !== undefined) window.clearTimeout(flashTimeoutRef.current)
  }, [])

  // A real click, so the native picker is guaranteed to open (some browsers
  // refuse it otherwise) and the reviewer sees why before the OS dialog appears.
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
        // Same guard as the load effect: granting access is async, and the
        // reviewer may have switched papers before it resolves. Without this,
        // paper A's PDF could render while paper B is selected.
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

  // Current page = last page whose top has scrolled into the upper viewport.
  // Runs on every scroll, so it also reflects jumps from internal PDF links.
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
    hideLinkPreview()
  }

  // Keep the page input in sync with the current page (unless the user is editing it).
  useEffect(() => {
    if (document.activeElement !== pageInputRef.current) setPageInput(String(currentPage))
  }, [currentPage])

  /** How far scrolled into `pageNumber`, as a fraction of its rendered height
   *  (0 = top) — same convention as `MarkRect`. Reads live refs, so it's safe
   *  to call without being a `useEffect` dependency. */
  const readOffsetFraction = (pageNumber: number): number => {
    const root = containerRef.current
    const pageEl = pageRefs.current[pageNumber - 1]
    if (!root || !pageEl) return 0
    const pageRect = pageEl.getBoundingClientRect()
    if (pageRect.height <= 0) return 0
    const fraction = (root.getBoundingClientRect().top - pageRect.top) / pageRect.height
    return Math.min(1, Math.max(0, fraction))
  }

  // "Continue where you left off": persists page + scroll offset, debounced
  // so fast scrolling doesn't spam localStorage. `paperId` is captured in the
  // closure rather than read fresh, so a late-firing timeout can't attribute
  // this position to a paper the reviewer has since switched to.
  useEffect(() => {
    if (!paperId) return
    const t = window.setTimeout(
      () => noteReadingPosition(paperId, currentPage, readOffsetFraction(currentPage)),
      500,
    )
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, currentPage, noteReadingPosition])

  const scrollToPage = (n: number) => {
    const count = pageRefs.current.length
    if (count === 0) return
    const clamped = Math.min(Math.max(1, n), count)
    setCurrentPage(clamped)
    pageRefs.current[clamped - 1]?.scrollIntoView({ block: 'start' })
  }

  // Jump to the remembered page/offset once this paper's pages mount, and
  // consume the one-shot request. Re-applied on every `textRenderTick`
  // (not just once) because pages start at placeholder height and grow as
  // their text layers render, which would otherwise push the target out
  // from under an already-applied scroll position.
  useEffect(() => {
    if (numPages === 0 || !initialPdfPosition || initialPdfPosition.paperId !== paperId) return
    const root = containerRef.current
    const pageEl = pageRefs.current[initialPdfPosition.page - 1]
    if (root && pageEl) {
      // Same rect-delta technique as `scrollToMark`, not `scrollIntoView` +
      // a manual adjustment — mixing the two let the page land right while
      // the offset within it didn't.
      const pageRect = pageEl.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      const targetTop = pageRect.top + initialPdfPosition.offsetFraction * pageRect.height
      root.scrollTop += targetTop - rootRect.top
      setCurrentPage(initialPdfPosition.page)
    } else {
      // Pages not mounted yet — fall back to the plain page jump; the next
      // render tick (pages now present) retries with the full rect math above.
      scrollToPage(initialPdfPosition.page)
    }
    const t = window.setTimeout(clearInitialPdfPosition, 800)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPages, initialPdfPosition, paperId, textRenderTick])

  /** Scroll to a mark's position on its page, centering it like the in-PDF
   *  search's active match. Falls back to `scrollToPage` if not rendered yet
   *  (shouldn't happen — no virtualization). */
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
    // NFC: pdf.js can split an accented letter's base + combining mark across
    // adjacent spans (see pdfText.ts's identical fix), so a selection crossing
    // that boundary reads back decomposed unless normalized here.
    const text = (sel?.toString() ?? '').normalize('NFC')
    if (text.trim()) setPdfSelection(text)
    updateSelectionToolbar(sel, text)
  }

  /**
   * A mark's overlay div sits on top of pdf.js's text layer so it can be
   * clicked/hovered, but that means a mousedown starting on a mark could
   * never anchor a native text selection — dragging to select text "through"
   * a highlight landed on the empty overlay div instead of the real text.
   *
   * Fix: turn off pointer-events on marks for the whole gesture (via
   * `.pdf-marks-dragging`, one class on the scroll container) so
   * `document.caretRangeFromPoint` can see the real text underneath, and
   * drive selection manually (anchor on mousedown, extend on mousemove past
   * a threshold) since disabling pointer-events also kills the native click
   * and drag-selection this used to rely on.
   *
   * `caretRangeFromPoint`/`Selection.extend` rather than the browser's own
   * drag-selection continuation, since whether a mousedown starting on a
   * non-text element keeps extending the selection isn't reliable to depend
   * on (moot here — SaiLoR only runs in Electron/Chromium).
   */
  const handleMarkMouseDown = (e: React.MouseEvent<HTMLElement>, onOpen: (e: MarkOpenEvent) => void) => {
    if (e.button !== 0) return // left button only — never hijack a right-click
    // Browser's own mousedown handling would reset the selection set below.
    e.preventDefault()
    // Applied synchronously too: the state only lands after a re-render, and
    // `caretRangeFromPoint` below must already see through the mark.
    containerRef.current?.classList.add('pdf-marks-dragging')
    setMarkDragActive(true)

    const startX = e.clientX
    const startY = e.clientY
    const sel = window.getSelection()
    const anchor = document.caretRangeFromPoint(startX, startY)
    if (sel && anchor) {
      sel.removeAllRanges()
      sel.addRange(anchor)
    }

    let dragging = false
    const DRAG_THRESHOLD_PX = 4
    const onMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return
        dragging = true
      }
      const focus = sel && document.caretRangeFromPoint(ev.clientX, ev.clientY)
      if (focus) sel.extend(focus.startContainer, focus.startOffset)
    }
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      containerRef.current?.classList.remove('pdf-marks-dragging')
      setMarkDragActive(false)
      // Not a drag: restore click-to-open, which native `onClick` can no
      // longer provide (see this function's doc comment).
      if (!dragging) onOpen(ev)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  /** Which rendered page (1-indexed) `node` sits inside — matched via
   *  `pageRefs` rather than trusting a pdf.js/react-pdf internal attribute. */
  const pageNumberForNode = (node: Node | null): number | null => {
    const el = node instanceof Element ? node : node?.parentElement ?? null
    const pageEl = el?.closest<HTMLElement>('.react-pdf__Page')
    if (!pageEl) return null
    const idx = pageRefs.current.indexOf(pageEl as HTMLDivElement)
    return idx === -1 ? null : idx + 1
  }

  /** Every text node inside `root`, via a `SHOW_TEXT` walk rather than
   *  `root.lastChild`/children: pdf.js appends a trailing `.endOfContent`
   *  marker div (extends the hit-area for "select to end of page") that can
   *  get stuck expanded to the whole page — `SHOW_TEXT` skips it for free,
   *  where `setEndAfter(lastChild)` used to include it and blow out the rect. */
  const textNodesOf = (root: Node): Text[] => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
    return nodes
  }

  /** Top of `node` as a fraction of `pageEl`'s own height (0 = page top),
   *  the same coordinate space `rectsForPageRange` renders marks in. */
  const textNodeTopFraction = (node: Text, pageEl: HTMLDivElement): number => {
    const r = document.createRange()
    r.selectNode(node)
    const rect = r.getBoundingClientRect()
    const pageRect = pageEl.getBoundingClientRect()
    return pageRect.height > 0 ? (rect.top - pageRect.top) / pageRect.height : 0
  }

  /** Fraction of page height (from top and bottom) treated as a likely
   *  running header/footer when auto-extending a selection onto a page the
   *  reviewer didn't start/end their drag on — never applied to the page(s)
   *  they actually clicked/released on. */
  const AUTO_EXTEND_MARGIN = 0.08

  /** Split a Range crossing page boundaries into one sub-range per page
   *  (`startPage`..`endPage`), clamped to that page's text layer. On pages
   *  other than the true start/end, the boundary stops before a likely
   *  header/footer (see `AUTO_EXTEND_MARGIN`). A page that ends up empty
   *  (e.g. entirely header/footer) is omitted. */
  const splitRangeByPage = (range: Range, startPage: number, endPage: number): { page: number; range: Range }[] => {
    const out: { page: number; range: Range }[] = []
    for (let p = startPage; p <= endPage; p++) {
      const pageEl = pageRefs.current[p - 1]
      const textLayer = pageEl?.querySelector('.react-pdf__Page__textContent')
      if (!pageEl || !textLayer) continue
      const nodes = textNodesOf(textLayer)

      // Header-clipped start / footer-clipped end for an auto-extended
      // boundary (see `AUTO_EXTEND_MARGIN`). `null` means the whole page
      // read as header/footer — handled below by contributing no range.
      const clippedStart = nodes.find((n) => textNodeTopFraction(n, pageEl) >= AUTO_EXTEND_MARGIN) ?? null
      let clippedEnd: Text | null = null
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (textNodeTopFraction(nodes[i], pageEl) <= 1 - AUTO_EXTEND_MARGIN) {
          clippedEnd = nodes[i]
          break
        }
      }

      const sub = document.createRange()
      try {
        if (p === startPage) {
          sub.setStart(range.startContainer, range.startOffset)
        } else if (clippedStart) {
          sub.setStart(clippedStart, 0)
        } else {
          continue // whole page is header/footer — nothing of it belongs in this highlight
        }
        if (p === endPage) {
          sub.setEnd(range.endContainer, range.endOffset)
        } else if (clippedEnd) {
          sub.setEnd(clippedEnd, clippedEnd.length)
        } else {
          continue
        }
      } catch {
        // Clipped boundary landed on the wrong side of the reviewer's real
        // click/release point (e.g. selection started inside a footer) —
        // fall back to this page's full, unclipped text.
        sub.setStart(p === startPage ? range.startContainer : textLayer, p === startPage ? range.startOffset : 0)
        const last = nodes[nodes.length - 1]
        if (p === endPage) sub.setEnd(range.endContainer, range.endOffset)
        else if (last) sub.setEnd(last, last.length)
        else sub.setEnd(textLayer, 0)
      }
      out.push({ page: p, range: sub })
    }
    return out
  }

  /** Rects for one page's (sub-)range, as fractions of that page's own
   *  rendered size — the same math every single-page selection has always
   *  used, factored out so a cross-page selection can reuse it per page. */
  const rectsForPageRange = (range: Range, pageEl: HTMLDivElement): MarkRect[] => {
    const pageRect = pageEl.getBoundingClientRect()
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => ({
        x: (r.left - pageRect.left) / pageRect.width,
        y: (r.top - pageRect.top) / pageRect.height,
        width: r.width / pageRect.width,
        height: r.height / pageRect.height,
      }))
    return dedupeOverlappingRects(rects)
  }

  /** Offers the highlight color toolbar for a real text selection — a single
   *  page, or a selection spanning a contiguous forward page range (split
   *  into one highlight fragment per page via `splitRangeByPage`). Hides it
   *  otherwise (nothing selected, or a malformed/backward range). */
  const updateSelectionToolbar = (sel: Selection | null, text: string) => {
    if (!sel || sel.isCollapsed || !text.trim()) {
      setSelectionToolbar(null)
      return
    }
    const range = sel.getRangeAt(0)
    const startPage = pageNumberForNode(range.startContainer)
    const endPage = pageNumberForNode(range.endContainer)
    if (startPage === null || endPage === null || endPage < startPage) {
      setSelectionToolbar(null)
      return
    }

    if (startPage === endPage) {
      const pageEl = pageRefs.current[startPage - 1]
      if (!pageEl) {
        setSelectionToolbar(null)
        return
      }
      const rects = rectsForPageRange(range, pageEl)
      if (rects.length === 0) {
        setSelectionToolbar(null)
        return
      }
      const clientRects = Array.from(range.getClientRects())
      const anchor = clientRects[clientRects.length - 1] ?? range.getBoundingClientRect()
      setActiveMark(null)
      setSelectionToolbar({ x: anchor.right, y: anchor.bottom, spans: [{ page: startPage, rects }], text })
      return
    }

    const perPage = splitRangeByPage(range, startPage, endPage)
    const spans: { page: number; rects: MarkRect[] }[] = []
    let anchor: { x: number; y: number } | null = null
    for (const { page, range: pageRange } of perPage) {
      const pageEl = pageRefs.current[page - 1]
      if (!pageEl) continue
      const rects = rectsForPageRange(pageRange, pageEl)
      if (rects.length === 0) continue
      spans.push({ page, rects })
      const clientRects = Array.from(pageRange.getClientRects())
      const last = clientRects[clientRects.length - 1] ?? pageRange.getBoundingClientRect()
      anchor = { x: last.right, y: last.bottom }
    }
    if (spans.length === 0 || !anchor) {
      setSelectionToolbar(null)
      return
    }
    setActiveMark(null)
    setSelectionToolbar({ x: anchor.x, y: anchor.y, spans, text })
  }

  /** Highlights the pending selection in `color`, closes the toolbar, and
   *  opens the new mark's comment popover right away so a note can be typed
   *  at once — the same flow as clicking an existing highlight. */
  const commitHighlight = (color: string) => {
    if (!selectionToolbar) return
    const { x, y, spans, text } = selectionToolbar
    const groupId = spans.length > 1 ? crypto.randomUUID() : undefined
    let id: string | null = null
    for (const span of spans) {
      const spanId = addHighlight(span.page, span.rects, color, undefined, text, groupId)
      if (id === null) id = spanId
    }
    setSelectionToolbar(null)
    window.getSelection()?.removeAllRanges()
    if (id) {
      setActiveMark({ id, x, y })
      setLastCreatedMarkId(id)
    }
  }

  /** Flash a mark, scrolling to it first unless `onlyIfHidden` says it's
   *  already on screen. Cycling always scrolls (Next/Prev means "move,
   *  centering it"); `onlyIfHidden` is for callers where the mark was only
   *  named, not navigated to — jumping the page would be disorienting. */
  const flashAndScrollTo = (mark: PdfMark, opts: { onlyIfHidden?: boolean } = {}) => {
    const root = containerRef.current
    const pageEl = pageRefs.current[mark.page - 1]
    const alreadyVisible =
      !!opts.onlyIfHidden &&
      !!root &&
      !!pageEl &&
      markVerticallyVisible(mark, pageEl.getBoundingClientRect(), root.getBoundingClientRect())
    if (!alreadyVisible) scrollToMark(mark)
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

  // A jump requested from elsewhere (the field-link popover) — flash the
  // mark and clear the request, leaving that popover open.
  const pendingMarkJump = useStore((s) => s.pendingMarkJump)
  const setPendingMarkJump = useStore((s) => s.setPendingMarkJump)
  useEffect(() => {
    if (!pendingMarkJump) return
    const mark = marks.find((m) => m.id === pendingMarkJump)
    if (mark) flashAndScrollTo(mark, { onlyIfHidden: true })
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
    if (id) {
      setActiveMark({ id, x: e.clientX, y: e.clientY })
      setLastCreatedMarkId(id)
    }
  }

  // Record the position jumped from so the reviewer can get back. The scroll
  // happens async after the click, so poll briefly and only record if the
  // view actually moved (ignores external links, which don't move it).
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
    hideLinkPreview() // the jump is about to move the view out from under it
    const root = containerRef.current
    if (root) recordJumpIfMoved(root.scrollTop)
  }

  /** A page's text items in scale-1 viewport coordinates (`PreviewTextItem`). */
  const pageTextItems = async (page: PDFPageProxy): Promise<PreviewTextItem[]> => {
    const vp = page.getViewport({ scale: 1 })
    const textContent = await page.getTextContent()
    return textContent.items.flatMap((it) => {
      if (!('str' in it)) return [] // TextMarkedContent — no geometry
      const [ix, iy] = vp.convertToViewportPoint(it.transform[4], it.transform[5])
      return [{ str: it.str, x: ix, y: iy - it.height, w: it.width, h: it.height }]
    })
  }

  /** Build the hover preview for an internal-link annotation: resolve its
   *  destination, then crop it via `renderPreview`. Returns `null` for
   *  external links or dangling destinations. */
  const resolveLinkPreview = async (
    doc: PDFDocumentProxy,
    pageNum: number,
    annotationId: string,
  ): Promise<LinkPreviewImage | null> => {
    const srcPage = await doc.getPage(pageNum)
    const annots: { id: string; url?: string; dest?: string | unknown[] }[] = await srcPage.getAnnotations()
    const annot = annots.find((a) => a.id === annotationId)
    if (!annot || annot.url || !annot.dest) return null // external link, or no jump target
    const dest = typeof annot.dest === 'string' ? await doc.getDestination(annot.dest) : annot.dest
    if (!Array.isArray(dest) || dest.length === 0) return null
    // The explicit destination's page: usually a Ref, but some producers
    // (and remote-destination edge cases) put a plain page index there.
    const targetIndex = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0])
    const targetPage = await doc.getPage(targetIndex + 1)
    const { x, y } = destinationPoint(dest)
    const vp = targetPage.getViewport({ scale: 1 })
    const view = targetPage.view // [x0, y0, x1, y1] in PDF user space
    const [vx, vy] = vp.convertToViewportPoint(x ?? view[0], y ?? view[3])
    return renderPreview(targetPage, targetIndex, x !== null ? vx : null, vy)
  }

  /** Preview for plain-text citation `[num]` hovered on page `pageNum`: the
   *  reference list is searched from the last page back to the citing page
   *  (the list sits after its citations), like SumatraPDF does. */
  const resolveCitationPreview = async (
    doc: PDFDocumentProxy,
    pageNum: number,
    num: number,
  ): Promise<LinkPreviewImage | null> => {
    if (citeLookupRef.current?.doc !== doc) citeLookupRef.current = { doc, found: new Map() }
    const found = citeLookupRef.current.found
    if (!found.has(num)) {
      let hit: { page: number; x: number; y: number } | null = null
      for (let p = pageRefs.current.length; p >= pageNum && !hit; p--) {
        const at = findNumericReference(await pageTextItems(await doc.getPage(p)), num)
        if (at) hit = { page: p, ...at }
      }
      found.set(num, hit)
    }
    const hit = found.get(num)
    if (!hit) return null
    return renderPreview(await doc.getPage(hit.page), hit.page - 1, hit.x, hit.y)
  }

  /** Copy the preview for a destination point (scale-1 viewport coordinates;
   *  `vx` null when the destination has no x) from page `targetIndex`'s
   *  already-rendered canvas: fit the crop to the destination's entry
   *  (`detectEntryBox`, SumatraPDF-style), falling back to a page-wide window.
   *  Returns `null` for an unrendered page or a destination at its very edge. */
  const renderPreview = async (
    targetPage: PDFPageProxy,
    targetIndex: number,
    vx: number | null,
    vy: number,
  ): Promise<LinkPreviewImage | null> => {
    const canvas = pageRefs.current[targetIndex]?.querySelector('canvas')
    if (!canvas || canvas.width === 0) return null
    const vp = targetPage.getViewport({ scale: 1 })
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null

    const entry = detectEntryBox(await pageTextItems(targetPage), vx, vy, vp.height)

    // Crop in CSS px on the rendered page. Fallback (no entry to fit — a
    // figure/table/section target): a page-wide window below the destination.
    const k = rect.width / vp.width // CSS px per viewport unit
    const pad = 6
    let crop: { x: number; y: number; w: number; h: number }
    if (entry) {
      crop = { x: entry.x * k, y: entry.y * k, w: entry.w * k, h: entry.h * k }
    } else {
      const cx = Math.max(0, Math.min(1, (vx ?? 0) / vp.width) * rect.width - pad)
      const cy = Math.max(0, Math.min(1, vy / vp.height) * rect.height - pad)
      const cw = rect.width - cx
      crop = { x: cx, y: cy, w: cw, h: cw * (LINK_PREVIEW_MAX_H / LINK_PREVIEW_MAX_W) }
    }
    crop.x = Math.max(0, crop.x)
    crop.y = Math.max(0, crop.y)
    crop.w = Math.min(crop.w, rect.width - crop.x)
    crop.h = Math.min(crop.h, rect.height - crop.y)
    if (crop.w < 40 || crop.h < 12) return null // destination at the very page edge

    // Copy at the source canvas's full resolution; scale down only at
    // display time (the img's width/height), so a shrunk preview stays sharp.
    const scale = canvas.width / rect.width // backing px per CSS px
    const out = document.createElement('canvas')
    out.width = Math.round(crop.w * scale)
    out.height = Math.round(crop.h * scale)
    const ctx = out.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(canvas, crop.x * scale, crop.y * scale, crop.w * scale, crop.h * scale, 0, 0, out.width, out.height)
    const fit = Math.min(1, LINK_PREVIEW_MAX_W / crop.w, LINK_PREVIEW_MAX_H / crop.h)
    return { img: out.toDataURL(), width: Math.round(crop.w * fit), height: Math.round(crop.h * fit) }
  }

  /** Show a resolved preview next to `anchor` (captured before the async
   *  resolution) unless a newer hover superseded it (`token`). */
  const showPreview = (pending: Promise<LinkPreviewImage | null>, anchor: DOMRect, token: number) => {
    pending
      .then((p) => {
        if (!p || token !== linkHoverTokenRef.current) return
        // Same flip-up-when-cramped placement as `markTooltipCoords`, with the
        // preview's real height (known only now) instead of its fixed guess.
        const spaceBelow = window.innerHeight - anchor.bottom
        const openUp = spaceBelow < p.height + 12 && anchor.top > spaceBelow
        setLinkPreview({
          left: Math.max(8, Math.min(anchor.left, window.innerWidth - p.width - 16)),
          ...(openUp ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
          ...p,
        })
      })
      .catch(() => {}) // a malformed destination just means no preview
  }

  // Hover handlers for pdf.js's annotation-layer links, delegated from the
  // scroll container (the `<a>`s are pdf.js DOM, not React's). `relatedTarget`
  // checks keep the preview stable as mouseover/mouseout re-fire between a
  // link's descendants.
  const onPdfMouseOver = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null
    const a = target?.closest('.react-pdf__Page__annotations a')
    if (!(a instanceof HTMLAnchorElement)) return
    const from = e.relatedTarget instanceof Node ? e.relatedTarget : null
    if (from && a.contains(from)) return // still inside the same link
    const section = a.closest<HTMLElement>('section[data-annotation-id]')
    const annotationId = section?.dataset.annotationId
    const doc = pdfDocRef.current
    const pageNum = pageNumberForNode(a)
    if (!annotationId || !doc || pageNum === null) return
    citeHoverRef.current = null
    showPreview(resolveLinkPreview(doc, pageNum, annotationId), a.getBoundingClientRect(), ++linkHoverTokenRef.current)
  }
  const onPdfMouseOut = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null
    const a = target?.closest('.react-pdf__Page__annotations a')
    if (!a) return
    const to = e.relatedTarget instanceof Node ? e.relatedTarget : null
    if (to && a.contains(to)) return
    hideLinkPreview()
  }

  // Plain-text "[N]" citations: mousemove rather than mouseover, since one
  // text-layer span holds a whole line and so several citations.
  const onPdfMouseMove = (e: React.MouseEvent) => {
    if (e.buttons !== 0) return // selecting text
    const target = e.target as HTMLElement | null
    if (target?.closest('.react-pdf__Page__annotations a')) return // real link — handled by onPdfMouseOver
    let num: number | null = null
    let key: string | null = null
    let span: Element | null = null
    const caret = target?.closest('.react-pdf__Page__textContent')
      ? document.caretRangeFromPoint?.(e.clientX, e.clientY)
      : null
    const node = caret?.startContainer
    if (node instanceof Text && node.parentElement) {
      num = detectNumericCitation(node.data, caret!.startOffset)
      span = node.parentElement
      if (num !== null) key = `${num}:${node.data}`
    }
    if (key === citeHoverRef.current) return
    if (citeHoverRef.current !== null) hideLinkPreview()
    const doc = pdfDocRef.current
    const pageNum = span ? pageNumberForNode(span) : null
    if (num === null || !span || !doc || pageNum === null) return
    citeHoverRef.current = key
    const token = ++linkHoverTokenRef.current
    const line = span.getBoundingClientRect() // the span is one line; the cursor marks the citation's x
    showPreview(resolveCitationPreview(doc, pageNum, num), new DOMRect(e.clientX, line.top, 0, line.height), token)
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

  // Ctrl/Cmd+wheel zooms instead of scrolling (matches trackpad pinch-zoom).
  // Needs a real DOM listener with `passive: false` — React's synthetic
  // wheel handler is passive, so `preventDefault` on it would no-op.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      if (e.deltaY < 0) zoomIn()
      else if (e.deltaY > 0) zoomOut()
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [zoomIn, zoomOut])

  // Clear highlights when the viewer unmounts.
  useEffect(() => clearHighlights, [])

  // Dismiss the toolbar/popover on Escape or an outside mousedown — checked
  // via `closest` rather than the popovers' `stopPropagation`, which only
  // affects the later `click` event, not this earlier `mousedown`.
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

  // Pressing "a" while the highlight toolbar is up is a shortcut for its
  // first color swatch — guarded against firing while typing elsewhere.
  useEffect(() => {
    if (!selectionToolbar) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'a' && e.key !== 'A') return
      const target = e.target
      const editable =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (editable) return
      e.preventDefault()
      commitHighlight(MARK_COLORS[0])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectionToolbar])

  // (Re)compute matches when the (debounced) query, page set, or a text layer
  // finishes rendering changes. Recomputes against text layers already in the DOM.
  useEffect(() => {
    if (!searchOpen || !debouncedQuery) {
      matchesRef.current = []
      setMatchCount(0)
      setActiveMatch(0)
      clearHighlights()
      return
    }
    const root = containerRef.current
    const ranges = root ? findMatches(root, debouncedQuery, searchCaseSensitive) : []
    matchesRef.current = ranges
    setMatchCount(ranges.length)
    setActiveMatch((prev) => (ranges.length ? Math.min(prev, ranges.length - 1) : 0))
  }, [debouncedQuery, searchOpen, searchCaseSensitive, numPages, textRenderTick])

  // Stable callback so the memoized pages below don't change identity (which
  // would tear down and re-render the text layers on every search keystroke).
  const onTextLayerRendered = useCallback(() => setTextRenderTick((t) => t + 1), [])

  // Memoize pages so unrelated re-renders (typing in search, match updates)
  // reuse the same elements, keeping text layers stable. `marks` is still a
  // dependency since highlights render as each page's `children`, but that
  // only touches the cheap overlay `<div>`s, never pdf.js's own rendering.
  const pages = useMemo(
    () =>
      Array.from({ length: numPages }, (_, i) => {
        const pageNumber = i + 1
        const pageMarks = marks.filter((m) => m.page === pageNumber)
        const pageScreeningMarks = (screeningMarks ?? []).filter((m) => m.mark.page === pageNumber)
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
            {pageScreeningMarks.length > 0 && (
              <div className="pdf-marks-overlay">
                {pageScreeningMarks.map(({ seat, mark }) => (
                  <MarkOverlayItem
                    key={`screening:${seat}:${mark.id}`}
                    mark={mark}
                    flash=""
                    from={screeningSeatLabel(seat)}
                    // Read-only: nothing to open, but a drag across it still selects text.
                    onOpen={() => {}}
                    onMarkMouseDown={handleMarkMouseDown}
                  />
                ))}
              </div>
            )}
            {pageMarks.length > 0 && (
              <div className="pdf-marks-overlay">
                {pageMarks.map((mark) => (
                  <MarkOverlayItem
                    key={mark.id}
                    mark={mark}
                    flash={flashMarkId === mark.id ? ' flash' : ''}
                    onOpen={(e) => {
                      e.stopPropagation()
                      setSelectionToolbar(null)
                      setActiveMark({ id: mark.id, x: e.clientX, y: e.clientY })
                    }}
                    onMarkMouseDown={handleMarkMouseDown}
                  />
                ))}
              </div>
            )}
          </Page>
        )
      }),
    [numPages, renderWidth, onTextLayerRendered, marks, screeningMarks, flashMarkId],
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

  // Reachable now that a screening project may relax `pdf` to `""` (a
  // non-screening project's `pdf` is still required — `model/schema.ts`).
  if (!pdfPath) {
    return (
      <div className="panel pdf empty">
        <div>
          This paper has no PDF attached.
          {screening && (
            <>
              {' '}
              <button type="button" onClick={toggleScreeningPdf} title="Return to this paper's screening record">
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
            <button type="button" onClick={toggleScreeningPdf} title="Return to this paper's screening record">
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
            className={`icon-btn pdf-search-case${searchCaseSensitive ? ' active' : ''}`}
            title={
              searchCaseSensitive
                ? 'Matching exact case (e.g. "AI" no longer matches "contains"). Click to ignore case again.'
                : 'Ignoring case (e.g. "AI" also matches "contains"). Click to match exact case instead.'
            }
            aria-label="Toggle case-sensitive search"
            aria-pressed={searchCaseSensitive}
            onClick={() => setSearchCaseSensitive((c) => !c)}
          >
            Aa
          </button>
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
        className={`pdf-scroll${placingNote ? ' placing-note' : ''}${markDragActive ? ' pdf-marks-dragging' : ''}`}
        ref={containerRef}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        onScroll={updateCurrentPage}
        onClickCapture={onPdfClickCapture}
        onClick={placeNote}
        onMouseOver={onPdfMouseOver}
        onMouseOut={onPdfMouseOut}
        onMouseMove={onPdfMouseMove}
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
              title={grantingFolder ? 'Waiting for the folder picker to close' : "Grant access to the folder containing this project's PDFs"}
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
              // Cap what we mount: pdf.js ignores a lying /Count but doesn't
              // dedupe a DAG page tree — a 2.4 KB file can report 16M pages,
              // which without virtualization would try to build 16M page
              // elements (measured 3.6s/3.6GB), a certain renderer crash.
              setNumPages(Math.min(doc.numPages, MAX_PDF_PAGES))
              setTruncatedPages(doc.numPages > MAX_PDF_PAGES ? doc.numPages : 0)
              pdfDocRef.current = doc // for resolving link destinations on hover
            }}
            onLoadError={(err) => setError(String(err?.message ?? err))}
            loading={<div className="pdf-loading">Loading PDF…</div>}
            // External links open in a new tab instead of navigating the app
            // away; Electron's main process turns this into a system browser
            // open. Internal links are unaffected — LinkService just scrolls.
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
              : { left: selectionToolbar.x, top: selectionToolbar.y, opacity: 0, pointerEvents: 'none' }
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
                  : { left: activeMark.x, top: activeMark.y, opacity: 0, pointerEvents: 'none' }
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
                  title="Delete this highlight"
                  onClick={() => {
                    const links = mark.linkedFields ?? []
                    if (links.length > 0) {
                      const ok = window.confirm(
                        `This highlight is linked to ${links.length} field${links.length === 1 ? '' : 's'} as evidence ` +
                          `(${links.map((l) => l.label).join(', ')}). Delete it anyway?`,
                      )
                      if (!ok) return
                    }
                    removeMark(mark.id)
                    setActiveMark(null)
                  }}
                >
                  Delete
                </button>
                <button type="button" className="primary" title="Close this popover" onClick={() => setActiveMark(null)}>
                  Done
                </button>
              </div>
            </div>
          )
        })()}
      {linkPreview &&
        createPortal(
          <div
            className="pdf-link-preview"
            role="tooltip"
            style={{
              left: linkPreview.left,
              ...(linkPreview.top !== undefined ? { top: linkPreview.top } : { bottom: linkPreview.bottom }),
            }}
          >
            <img src={linkPreview.img} width={linkPreview.width} height={linkPreview.height} alt="Preview of the link's destination" />
          </div>,
          document.body,
        )}
    </div>
  )
}
