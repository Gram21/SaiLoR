// [impl->req~ann-200~1]
import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { METADATA_FIELDS, type MetadataField, type MetadataValues } from '../model/metadata'
import type { MetadataSources, PdfProposal } from '../model/pdfFolder'
import { parseYear } from '../model/year'
import { useT } from '../i18n'
import { Modal } from './Modal'

type Draft = Record<MetadataField, string>

function toDraft(v: MetadataValues): Draft {
  return {
    title: v.title ?? '',
    authors: (v.authors ?? []).join(', '),
    year: v.year === undefined ? '' : String(v.year),
    doi: v.doi ?? '',
  }
}

function confirmed(proposal: PdfProposal, draft: Draft): PdfProposal {
  const start = toDraft(proposal.values)
  const values: Record<string, unknown> = {}
  const sources: MetadataSources = {}
  for (const f of METADATA_FIELDS) {
    const text = draft[f].trim()
    // Unedited: keep the found value, or an author named "Smith, Jr." would split in two.
    const value =
      draft[f] === start[f]
        ? proposal.values[f]
        : f === 'authors'
          ? text.split(',').map((a) => a.trim()).filter(Boolean)
          : f === 'year'
            ? parseYear(text)
            : text || undefined
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue
    values[f] = value
    const source = draft[f] === start[f] ? proposal.sources[f] : 'manual'
    if (source) sources[f] = source
  }
  return { file: proposal.file, values: values as MetadataValues, sources }
}

function badYear(draft: Draft): boolean {
  return draft.year.trim() !== '' && parseYear(draft.year.trim()) === undefined
}

/** Lists the new PDF files of the last folder scan, so the user confirms each paper before it is added. */
export function PdfFolderDialog() {
  const t = useT()
  const proposals = useStore((s) => s.pdfProposals)
  const scanning = useStore((s) => s.pdfScanning)
  const error = useStore((s) => s.pdfScanError)
  const readOnly = useStore((s) => s.readOnly)
  const scanPdfFolder = useStore((s) => s.scanPdfFolder)
  const addPdfPapers = useStore((s) => s.addPdfPapers)
  const ignorePdfs = useStore((s) => s.ignorePdfs)
  const setPdfDialogOpen = useStore((s) => s.setPdfDialogOpen)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set())
  const onClose = () => setPdfDialogOpen(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPdfDialogOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setPdfDialogOpen])

  const draftOf = (p: PdfProposal) => drafts[p.file.sha256] ?? toDraft(p.values)
  const open = proposals.filter((p) => !skipped.has(p.file.sha256))
  const addable = open.filter((p) => !badYear(draftOf(p)))
  const add = (list: PdfProposal[]) => addPdfPapers(list.map((p) => confirmed(p, draftOf(p))))
  const rescan = () => {
    setSkipped(new Set())
    void scanPdfFolder(true)
  }

  return (
    <Modal onClose={onClose} className="metadata-dialog" aria-label={t('pdfFolder.title')}>
      <div className="modal-head">
        <strong>{t('pdfFolder.title')}</strong>
        <button type="button" className="icon-btn" title={t('common.close')} onClick={onClose} aria-label={t('common.close')}>
          ×
        </button>
      </div>
      <div className="modal-body">
        <div className="screening-import-actions">
          <button type="button" title={t('pdfFolder.rescanTitle')} disabled={scanning} onClick={rescan}>
            {scanning ? t('pdfFolder.scanning') : t('pdfFolder.rescan')}
          </button>
          <button
            type="button"
            className="primary"
            title={t('pdfFolder.addAllTitle')}
            disabled={readOnly || addable.length === 0}
            onClick={() => add(addable)}
          >
            {t('pdfFolder.addAll', { count: addable.length })}
          </button>
        </div>
        {error && <p className="ai-error">{error}</p>}
        {!scanning && !error && proposals.length === 0 && <p>{t('pdfFolder.none')}</p>}
        {proposals.map((p) => {
          const key = p.file.sha256
          if (skipped.has(key)) {
            return (
              <section key={key} className="metadata-entry" aria-label={p.file.path}>
                <h4>{p.file.path}</h4>
                <p>{t('pdfFolder.skipped')}</p>
              </section>
            )
          }
          const draft = draftOf(p)
          const start = toDraft(p.values)
          return (
            <section key={key} className="metadata-entry" aria-label={p.file.path}>
              <h4>{p.file.path}</h4>
              {p.sources.title === 'filename' && <p className="metadata-disagreement">{t('pdfFolder.metadataMissing')}</p>}
              {METADATA_FIELDS.map((f) => {
                const source = draft[f] !== start[f] ? 'manual' : p.sources[f]
                return (
                  <div key={f} className="metadata-field">
                    <label>
                      <span>{t(`metadata.field.${f}`)}</span>
                      <input
                        type="text"
                        value={draft[f]}
                        onChange={(ev) => setDrafts((prev) => ({ ...prev, [key]: { ...draft, [f]: ev.target.value } }))}
                      />
                    </label>
                    {source && <small>{t('pdfFolder.source', { source: t(`pdfFolder.source.${source}`) })}</small>}
                  </div>
                )
              })}
              {badYear(draft) && <p className="ai-error">{t('metadata.badYear')}</p>}
              <div className="screening-import-actions">
                <button type="button" title={t('pdfFolder.skipTitle')} onClick={() => setSkipped((prev) => new Set([...prev, key]))}>
                  {t('pdfFolder.skip')}
                </button>
                <button type="button" title={t('pdfFolder.ignoreTitle')} disabled={readOnly} onClick={() => ignorePdfs([key])}>
                  {t('pdfFolder.ignore')}
                </button>
                <button
                  type="button"
                  className="primary"
                  title={t('pdfFolder.addTitle')}
                  disabled={readOnly || badYear(draft)}
                  onClick={() => add([p])}
                >
                  {t('pdfFolder.add')}
                </button>
              </div>
            </section>
          )
        })}
      </div>
      
    </Modal>
  )
}
