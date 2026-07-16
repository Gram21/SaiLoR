import { useStore, selectCurrentPaper } from '../state/store'

/**
 * Middle pane for a screening project, shown instead of `PdfViewer` while
 * `screeningShowPdf` is off (the default). Screening is normally a title +
 * abstract decision by protocol, and the PDF is often entirely absent (a
 * fresh reference-manager export) — so this is the default surface, not
 * `PdfViewer` nested inside it. `PdfViewer` itself is untouched and reachable
 * with one click via the header's "Read the PDF" button, or automatically
 * once there is nothing here for it to compete with.
 */
export function ScreeningRecord() {
  const paper = useStore(selectCurrentPaper)
  const toggleScreeningPdf = useStore((s) => s.toggleScreeningPdf)
  const extracting = useStore((s) => s.screeningAbstractExtracting === paper?.id)

  if (!paper) {
    return <div className="panel pdf empty">No paper selected.</div>
  }

  return (
    <div className="panel pdf screening-record">
      <div className="pdf-head">
        <div className="pdf-meta">
          <span className="pdf-title">{paper.title}</span>
          {paper.authors.length > 0 && <span className="pdf-authors">{paper.authors.join(', ')}</span>}
          {paper.doi && (
            <span className="pdf-doi">
              DOI: <code>{paper.doi}</code>
            </span>
          )}
        </div>
        {paper.pdf !== '' && (
          <button type="button" onClick={toggleScreeningPdf}>
            Read the PDF
          </button>
        )}
      </div>
      <div className="screening-record-body">
        {paper.abstractFromPdf && (
          <p className="screening-abstract-extracted-notice">
            This abstract was extracted automatically from the PDF text, not recorded by the paper's
            source — it may be incomplete or wrong. Proceed with caution, and check the PDF directly
            if in doubt.
          </p>
        )}
        {paper.abstract ? (
          <p className="screening-abstract">{paper.abstract}</p>
        ) : extracting ? (
          <p className="screening-abstract-empty">Reading the PDF for an abstract…</p>
        ) : (
          <p className="screening-abstract-empty">No abstract recorded for this paper.</p>
        )}
      </div>
    </div>
  )
}
