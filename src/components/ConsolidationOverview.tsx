// [impl->req~ui-170~1]
// [impl->req~llm-830~1]
import { useEffect, useMemo, useState } from 'react'
import { projectVerdicts, type FieldVerdict } from '../consolidate/disagreements'
import { projectDisagreementsText } from '../consolidate/exportDisagreements'
import { consolidationFieldStatus } from './ConsolidationVerdicts'
import { paperMetadataHaystack } from './PaperList'
import { useStore } from '../state/store'
import { Dropdown } from './Dropdown'
import { AiEvaluationDialog } from './AiEvaluationDialog'
import { useExportTextMenu } from '../hooks/useExportTextMenu'
import { tp, useT } from '../i18n'
import { Modal } from './Modal'

interface DisagreementPaper {
  id: string
  title: string
  disagreements: number
  metadataHaystack: string
}

/** Project-wide entry point for Consolidation's batch actions and paper queue. */
export function ConsolidationOverview() {
  const t = useT()
  const open = useStore((s) => s.consolidationOverviewOpen)
  const setOpen = useStore((s) => s.setConsolidationOverviewOpen)
  const openAgreementFromOverview = useStore((s) => s.openAgreementFromOverview)
  const project = useStore((s) => s.project)
  const generation = useStore((s) => s.projectGeneration)
  const openDisagreementsFromOverview = useStore((s) => s.openDisagreementsFromOverview)
  const adoptAllUnanimousAnnotations = useStore((s) => s.adoptAllUnanimousAnnotations)
  const readOnly = useStore((s) => s.readOnly)
  const [aiEvalOpen, setAiEvalOpen] = useState(false)
  const unanimousRun = useStore((s) => s.unanimousRun)
  const dismissUnanimousRun = useStore((s) => s.dismissUnanimousRun)
  const [query, setQuery] = useState('')

  useEffect(() => {
    setQuery('')
  }, [generation])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !aiEvalOpen) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen, aiEvalOpen])

  // Every disagreement verdict, grouped by paper — the export's own input, and
  // what `papers` below derives its per-paper counts from, so the two can
  // never disagree about which paper has how many.
  const verdictsByPaper = useMemo<Map<string, FieldVerdict[]>>(() => {
    const map = new Map<string, FieldVerdict[]>()
    if (!open || !project) return map
    for (const verdict of projectVerdicts(project)) {
      // The same verdict the field's own red border comes from — see
      // `DisagreementOverview`'s note on why this calls rather than restates.
      if (
        consolidationFieldStatus(
          verdict.answeredBy.length,
          project.reviewers,
          verdict.agree,
          verdict.oneSided,
          verdict.participantCount,
        ) === 'disagree'
      ) {
        const list = map.get(verdict.paperId)
        if (list) list.push(verdict)
        else map.set(verdict.paperId, [verdict])
      }
    }
    return map
  }, [open, project])

  const papers = useMemo<DisagreementPaper[]>(() => {
    if (!project) return []
    return project.papers.flatMap((paper) => {
      // [impl->req~con-390~1]
      const verdicts = verdictsByPaper.get(paper.id)
      return verdicts
        ? [
            {
              id: paper.id,
              title: paper.title,
              disagreements: verdicts.length,
              metadataHaystack: paperMetadataHaystack(paper),
            },
          ]
        : []
    })
  }, [project, verdictsByPaper])

  const exportMenu = useExportTextMenu(
    () => (project ? projectDisagreementsText(project.papers, verdictsByPaper) : ''),
    'disagreements.txt',
  )

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const filtered = papers.filter((paper) => words.every((word) => paper.metadataHaystack.includes(word)))

  if (!open || !project) return null

  // [impl->req~con-260~1]
  const total = papers.reduce((count, paper) => count + paper.disagreements, 0)

  return (
    <>
    <Modal onClose={() => setOpen(false)} className="consolidation-overview">
      <div className="modal-head">
        <strong>{t('consolidation.overview.title')}</strong>
        <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label={t('common.close')} title={t('consolidation.overview.closeTitle')}>
          ×
        </button>
      </div>
      <div className="modal-body">
        <div className="consolidation-overview-actions">
          <button
            type="button"
            className="primary"
            title={
              unanimousRun?.running
                ? t('consolidation.overview.adoptingTitle', { done: unanimousRun.done, total: unanimousRun.total })
                : t('consolidation.overview.adoptAllTitle')
            }
            disabled={unanimousRun?.running || readOnly}
            onClick={() => void adoptAllUnanimousAnnotations()}
          >
            {unanimousRun?.running
              ? t('consolidation.overview.adopting', { done: unanimousRun.done, total: unanimousRun.total })
              : t('consolidation.overview.adoptAll')}
          </button>
          <button type="button" onClick={openAgreementFromOverview} title={t('consolidation.overview.agreementTitle')}>
            {t('consolidation.overview.agreement')}
          </button>
          {project.aiEnabled && (
            <button type="button" onClick={() => setAiEvalOpen(true)} title={t('consolidation.overview.aiEvalTitle')}>
              {t('consolidation.overview.aiEval')}
            </button>
          )}
          <Dropdown label={t('consolidation.export')} title={t('consolidation.overview.exportTitle')} items={exportMenu.items} />
          {exportMenu.status && <span className="export-status">{exportMenu.status}</span>}
        </div>
        {unanimousRun && !unanimousRun.running && (
          <div className="consolidation-run-notice">
            <span>
              {unanimousRun.interrupted
                ? t('consolidation.overview.stopped', { done: unanimousRun.done, total: unanimousRun.total })
                : ''}
              {tp('consolidation.overview.adopted', unanimousRun.filled)}
              {unanimousRun.skipped > 0 && t('consolidation.overview.leftUnchanged', { skipped: unanimousRun.skipped })}
            </span>
            <button type="button" onClick={dismissUnanimousRun} title={t('consolidation.overview.dismissTitle')}>
              {t('consolidation.overview.dismiss')}
            </button>
          </div>
        )}
        <p className="disagreement-intro">
          {total === 0
            ? t('consolidation.overview.noneLeft')
            : t('consolidation.overview.intro', {
                disagreements: tp('consolidation.disagreementCount', total),
                papers: tp('consolidation.paperCount', papers.length),
              })}
        </p>
        <div className="paper-search consolidation-overview-search">
          <input
            className="paper-search-input"
            type="text"
            placeholder={t('consolidation.overview.searchPlaceholder')}
            aria-label={t('consolidation.overview.searchLabel')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {filtered.length === 0 ? (
          <p className="paper-list-empty">
            {words.length > 0 ? t('consolidation.overview.noMatch') : t('consolidation.overview.noneListed')}
          </p>
        ) : (
          <ul className="consolidation-overview-papers">
            {filtered.map((paper) => (
              <li key={paper.id}>
                <button
                  type="button"
                  onClick={() => openDisagreementsFromOverview(paper.id)}
                  title={t('consolidation.overview.openPaper')}
                >
                  <span>{paper.title}</span>
                  <span>{tp('consolidation.disagreementCount', paper.disagreements)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      
    </Modal>
    {aiEvalOpen && <AiEvaluationDialog onClose={() => setAiEvalOpen(false)} />}
    </>
  )
}