// [impl->req~ann-180~1]
// [impl->req~con-530~1]
// [impl->req~dat-470~1]
import { useEffect, useMemo, useState } from 'react'
import { metadataSeat, useStore, type MetadataEdit } from '../state/store'
import {
  METADATA_FIELDS,
  canUpdateProject,
  consolidationPending,
  effectiveMetadata,
  humanSeats,
  mergeSeatMetadata,
  metadataSeatKey,
  type FieldMerge,
  type MetadataField,
  type MetadataValues,
} from '../model/metadata'
import { seatLabel, type Paper } from '../model/project'
import { parseYear } from '../model/year'
import { useT } from '../i18n'

type Draft = Record<MetadataField, string>
type Kind = 'current' | 'proposal' | 'consolidation'

interface Entry {
  key: string
  kind: Kind
  paper: Paper
  base: Draft
  start: Draft
  proposal?: MetadataValues
  merge?: FieldMerge[]
}

function toDraft(v: MetadataValues): Draft {
  return {
    title: v.title ?? '',
    authors: (v.authors ?? []).join(', '),
    year: v.year === undefined ? '' : String(v.year),
    doi: v.doi ?? '',
  }
}

function fromDraft(draft: Draft, base: Draft): MetadataValues {
  const out: Record<string, unknown> = {}
  for (const f of METADATA_FIELDS) {
    if (draft[f] === base[f]) continue
    const text = draft[f].trim()
    if (f === 'authors') out[f] = text.split(',').map((a) => a.trim()).filter(Boolean)
    else if (f === 'year') out[f] = parseYear(text)
    else out[f] = text || undefined
  }
  return out as MetadataValues
}

function badYear(draft: Draft): boolean {
  return draft.year.trim() !== '' && parseYear(draft.year.trim()) === undefined
}

function shown(v: unknown, none: string): string {
  if (v === undefined || v === null || v === '') return none
  return Array.isArray(v) ? v.join(', ') : String(v)
}

/** Lists the current paper, the PDF proposals and, in Consolidation, the reviewer corrections. */
export function MetadataDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const project = useStore((s) => s.project)
  const currentPaperId = useStore((s) => s.currentPaperId)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const strictPerson = useStore((s) => s.strictPerson)
  const applyMetadataEdits = useStore((s) => s.applyMetadataEdits)
  const scanPdfMetadata = useStore((s) => s.scanPdfMetadata)
  const [proposals, setProposals] = useState<{ paperId: string; values: MetadataValues }[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const entries = useMemo(() => {
    if (!project) return []
    const seatState = { project, strictPerson, currentReviewer }
    const out: Entry[] = []
    const current = project.papers.find((p) => p.id === currentPaperId)
    const currentKey = current ? metadataSeatKey(project, metadataSeat(seatState, current.id)) : null
    if (current && currentKey) {
      const base = toDraft(effectiveMetadata(current, currentKey))
      out.push({ key: `current:${current.id}`, kind: 'current', paper: current, base, start: base })
    }
    if (canUpdateProject(project, currentReviewer)) {
      const seats = humanSeats(project)
      for (const paper of project.papers) {
        if (!consolidationPending(paper, seats)) continue
        const merge = mergeSeatMetadata(paper, seats)
        const agreed: Record<string, unknown> = {}
        for (const m of merge) if (m.agreed) agreed[m.field] = Object.values(m.seats)[0]
        out.push({
          key: `consolidation:${paper.id}`,
          kind: 'consolidation',
          paper,
          base: toDraft(effectiveMetadata(paper, null)),
          start: toDraft({ ...effectiveMetadata(paper, null), ...agreed }),
          merge,
        })
      }
    }
    for (const prop of proposals ?? []) {
      const paper = project.papers.find((p) => p.id === prop.paperId)
      if (!paper) continue
      const seatKey = metadataSeatKey(project, metadataSeat(seatState, paper.id))
      if (!seatKey) continue
      const current = effectiveMetadata(paper, seatKey)
      out.push({
        key: `proposal:${paper.id}`,
        kind: 'proposal',
        paper,
        base: toDraft(current),
        start: toDraft({ ...current, ...prop.values }),
        proposal: prop.values,
      })
    }
    return out.filter((e) => !hidden.has(e.key))
  }, [project, currentPaperId, currentReviewer, strictPerson, proposals, hidden])

  if (!project) return null

  const draftOf = (e: Entry) => drafts[e.key] ?? e.start
  const hide = (keys: string[]) => setHidden((prev) => new Set([...prev, ...keys]))
  const editOf = (e: Entry): MetadataEdit => {
    const values = fromDraft(draftOf(e), e.base)
    return e.kind === 'consolidation' ? { paperId: e.paper.id, update: values } : { paperId: e.paper.id, values }
  }
  const submit = (e: Entry) => {
    applyMetadataEdits([editOf(e)])
    hide([e.key])
  }
  const ignore = (e: Entry) => {
    if (e.kind === 'proposal') applyMetadataEdits([{ paperId: e.paper.id, ignore: e.proposal }])
    else applyMetadataEdits([{ paperId: e.paper.id, update: {} }])
    hide([e.key])
  }
  const confirmAll = (list: Entry[]) => {
    const ok = list.filter((e) => !badYear(draftOf(e)))
    applyMetadataEdits(ok.map(editOf))
    hide(ok.map((e) => e.key))
  }
  const saveable = entries.filter((e) => e.kind === 'proposal')
  const acceptable = entries.filter((e) => e.kind === 'consolidation' && e.merge!.every((m) => m.agreed))
  const annotator = currentPaperId !== null && metadataSeatKey(project, metadataSeat({ project, strictPerson, currentReviewer }, currentPaperId)) !== null
  const updater = canUpdateProject(project, currentReviewer)
  const check = async () => {
    setScanning(true)
    try {
      setProposals(await scanPdfMetadata())
      setHidden((prev) => new Set([...prev].filter((k) => !k.startsWith('proposal:'))))
    } finally {
      setScanning(false)
    }
  }
  const none = t('metadata.none')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal metadata-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('metadata.title')}
      >
        <div className="modal-head">
          <strong>{t('metadata.title')}</strong>
          <button type="button" className="icon-btn" title={t('common.close')} onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="screening-import-actions">
            {annotator && (
              <>
                <button type="button" title={t('metadata.checkTitle')} disabled={scanning} onClick={() => void check()}>
                  {scanning ? t('metadata.checking') : t('metadata.check')}
                </button>
                <button
                  type="button"
                  title={t('metadata.saveAllTitle')}
                  disabled={scanning || saveable.length === 0}
                  onClick={() => confirmAll(saveable)}
                >
                  {t('metadata.saveAll', { count: saveable.length })}
                </button>
              </>
            )}
            {updater && (
              <button
                type="button"
                className="primary"
                title={t('metadata.acceptAllTitle')}
                disabled={acceptable.length === 0}
                onClick={() => confirmAll(acceptable)}
              >
                {t('metadata.acceptAll', { count: acceptable.length })}
              </button>
            )}
          </div>
          {proposals !== null && proposals.length === 0 && <p>{t('metadata.noProposals')}</p>}
          {entries.length === 0 && <p>{t('metadata.empty')}</p>}
          {entries.map((e) => {
            const draft = draftOf(e)
            return (
              <section key={e.key} className="metadata-entry" aria-label={e.paper.id}>
                <h4>
                  {t(`metadata.kind.${e.kind}`)}: {e.paper.id}
                </h4>
                {METADATA_FIELDS.map((f) => {
                  const m = e.merge?.find((x) => x.field === f)
                  return (
                    <div key={f} className="metadata-field">
                      <label>
                        <span>{t(`metadata.field.${f}`)}</span>
                        <input
                          type="text"
                          value={draft[f]}
                          onChange={(ev) => setDrafts((prev) => ({ ...prev, [e.key]: { ...draft, [f]: ev.target.value } }))}
                        />
                      </label>
                      {e.kind === 'proposal' && draft[f] !== e.base[f] && (
                        <small>{t('metadata.current', { value: e.base[f] || none })}</small>
                      )}
                      {m && (
                        <small className={m.agreed ? undefined : 'metadata-disagreement'}>
                          {m.agreed ? '' : `${t('metadata.disagreement')} `}
                          {Object.entries(m.seats)
                            .map(([seat, v]) => t('metadata.seatValue', { seat: seatLabel(project, seat), value: shown(v, none) }))
                            .join('; ')}
                        </small>
                      )}
                    </div>
                  )
                })}
                {badYear(draft) && <p className="ai-error">{t('metadata.badYear')}</p>}
                <div className="screening-import-actions">
                  <button type="button" title={t('metadata.skipTitle')} onClick={() => hide([e.key])}>
                    {t('metadata.skip')}
                  </button>
                  {e.kind !== 'current' && (
                    <button
                      type="button"
                      title={e.kind === 'proposal' ? t('metadata.ignoreTitle') : t('metadata.ignoreConsolidationTitle')}
                      onClick={() => ignore(e)}
                    >
                      {t('metadata.ignore')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="primary"
                    title={e.kind === 'consolidation' ? t('metadata.acceptTitle') : t('metadata.saveTitle')}
                    disabled={badYear(draft)}
                    onClick={() => submit(e)}
                  >
                    {e.kind === 'consolidation' ? t('metadata.accept') : t('metadata.save')}
                  </button>
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
