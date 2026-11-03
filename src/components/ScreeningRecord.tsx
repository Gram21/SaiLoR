// [impl->req~scr-280~1]
import { useStore, selectCurrentPaper } from '../state/store'
import { useT } from '../i18n'

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
  const t = useT()
  const paper = useStore(selectCurrentPaper)
  const toggleScreeningPdf = useStore((s) => s.toggleScreeningPdf)
  // [impl->req~scr-300~1]
  const extracting = useStore((s) => (paper ? s.screeningAbstractReads[paper.id] === 'reading' : false))

  if (!paper) {
    return <div className="panel pdf empty">{t('screening.record.noPaper')}</div>
  }

  return (
    <div className="panel pdf screening-record">
      <div className="pdf-head">
        <div className="pdf-meta">
          <span className="pdf-title">{paper.title}</span>
          {paper.authors.length > 0 && <span className="pdf-authors">{paper.authors.join(', ')}</span>}
          {/* Year/venue are exactly what a screener reads next after the
              authors — one line, since neither is worth its own row here. */}
          {(paper.venue || paper.year) && (
            <span className="pdf-venue">{[paper.venue, paper.year].filter(Boolean).join(' · ')}</span>
          )}
          {paper.doi && (
            <span className="pdf-doi">
              {t('screening.record.doi')} <code>{paper.doi}</code>
            </span>
          )}
        </div>
        {paper.pdf !== '' && (
          <button type="button" onClick={toggleScreeningPdf} title={t('screening.record.readPdfTitle')}>
            {t('screening.record.readPdf')}
          </button>
        )}
      </div>
      <div className="screening-record-body">
        {paper.abstractFromPdf && (
          <p className="screening-abstract-extracted-notice">{t('screening.record.extracted')}</p>
        )}
        {paper.abstract ? (
          <p className="screening-abstract">{paper.abstract}</p>
        ) : extracting ? (
          <p className="screening-abstract-empty">{t('screening.record.reading')}</p>
        ) : (
          <p className="screening-abstract-empty">{t('screening.record.noAbstract')}</p>
        )}
      </div>
    </div>
  )
}
