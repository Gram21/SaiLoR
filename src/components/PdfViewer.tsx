import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import { useStore, selectCurrentPaper, PDF_ZOOM_MIN, PDF_ZOOM_MAX } from '../state/store'
import { getPlatform } from '../platform'

// Load the pdf.js worker from the bundled dependency (works offline / in Electron).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

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

  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [width, setWidth] = useState(600)
  const containerRef = useRef<HTMLDivElement>(null)

  // PDF zoom lives in the store so keyboard shortcuts (Ctrl +/-) can drive it too.
  const zoom = useStore((s) => s.pdfZoom)
  const zoomIn = useStore((s) => s.zoomInPdf)
  const zoomOut = useStore((s) => s.zoomOutPdf)
  const resetZoom = useStore((s) => s.resetPdfZoom)
  // The page renders at the fit-to-width base size scaled by the zoom factor.
  const renderWidth = Math.round(width * zoom)

  // Resolve the PDF source only when the paper identity or its pdf path changes.
  useEffect(() => {
    let revoked: (() => void) | undefined
    let cancelled = false
    setError(null)
    setNumPages(0)
    setUrl(null)
    if (!pdfPath) return
    getPlatform()
      .getPdfSource(pdfPath, saveHandle ?? { kind: 'download' })
      .then((src) => {
        if (cancelled) {
          src.revoke?.()
          return
        }
        revoked = src.revoke
        setUrl(src.url)
      })
      .catch((err) => !cancelled && setError(String(err?.message ?? err)))
    return () => {
      cancelled = true
      revoked?.()
    }
  }, [paperId, pdfPath, saveHandle])

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

  // Capture the current text selection inside the viewer.
  const captureSelection = () => {
    const sel = window.getSelection()
    const text = sel?.toString() ?? ''
    if (text.trim()) setPdfSelection(text)
  }

  if (!paperId) {
    return <div className="panel pdf empty">No paper selected.</div>
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
      <div
        className="pdf-scroll"
        ref={containerRef}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
      >
        {error ? (
          <div className="pdf-error">Could not load PDF: {error}</div>
        ) : url ? (
          <Document
            file={url}
            onLoadSuccess={(doc) => setNumPages(doc.numPages)}
            onLoadError={(err) => setError(String(err?.message ?? err))}
            loading={<div className="pdf-loading">Loading PDF…</div>}
          >
            {Array.from({ length: numPages }, (_, i) => (
              <Page
                key={i}
                pageNumber={i + 1}
                width={renderWidth}
                renderTextLayer
                renderAnnotationLayer={false}
              />
            ))}
          </Document>
        ) : (
          <div className="pdf-loading">Loading PDF…</div>
        )}
      </div>
    </div>
  )
}
