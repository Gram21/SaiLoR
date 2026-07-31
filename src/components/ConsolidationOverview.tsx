import { useEffect, useMemo, useState } from 'react'
import { projectVerdicts } from '../consolidate/disagreements'
import { paperMetadataHaystack } from './PaperList'
import { useStore } from '../state/store'

interface DisagreementPaper {
  id: string
  title: string
  disagreements: number
  metadataHaystack: string
}

/** Project-wide entry point for Consolidation's batch actions and paper queue. */
export function ConsolidationOverview() {
  const open = useStore((s) => s.consolidationOverviewOpen)
  const setOpen = useStore((s) => s.setConsolidationOverviewOpen)
  const openAgreementFromOverview = useStore((s) => s.openAgreementFromOverview)
  const project = useStore((s) => s.project)
  const generation = useStore((s) => s.projectGeneration)
  const openDisagreementsFromOverview = useStore((s) => s.openDisagreementsFromOverview)
  const adoptAllUnanimousAnnotations = useStore((s) => s.adoptAllUnanimousAnnotations)
  const unanimousRun = useStore((s) => s.unanimousRun)
  const dismissUnanimousRun = useStore((s) => s.dismissUnanimousRun)
  const [query, setQuery] = useState('')

  useEffect(() => {
    setQuery('')
  }, [generation])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  const papers = useMemo<DisagreementPaper[]>(() => {
    if (!open || !project) return []
    const counts = new Map<string, number>()
    for (const verdict of projectVerdicts(project)) {
      if (
        (verdict.answeredBy.length >= 2 && !verdict.agree) ||
        (verdict.oneSided && verdict.answeredBy.length >= 1)
      ) {
        counts.set(verdict.paperId, (counts.get(verdict.paperId) ?? 0) + 1)
      }
    }
    return project.papers.flatMap((paper) => {
      const disagreements = counts.get(paper.id)
      return disagreements
        ? [{ id: paper.id, title: paper.title, disagreements, metadataHaystack: paperMetadataHaystack(paper) }]
        : []
    })
  }, [open, project])

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const filtered = papers.filter((paper) => words.every((word) => paper.metadataHaystack.includes(word)))

  if (!open || !project) return null

  const total = papers.reduce((count, paper) => count + paper.disagreements, 0)

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div
        className="modal consolidation-overview"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <strong>Consolidation overview</strong>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="consolidation-overview-actions">
            <button
              type="button"
              className="primary"
              disabled={unanimousRun?.running}
              onClick={() => void adoptAllUnanimousAnnotations()}
            >
              {unanimousRun?.running
                ? `Adopting… ${unanimousRun.done}/${unanimousRun.total}`
                : 'Adopt all unanimous'}
            </button>
            <button type="button" onClick={openAgreementFromOverview}>
              Agreement
            </button>
          </div>
          {unanimousRun && !unanimousRun.running && (
            <div className="consolidation-run-notice">
              <span>
                {unanimousRun.interrupted
                  ? `Stopped after ${unanimousRun.done} of ${unanimousRun.total} papers. `
                  : ''}
                Adopted unanimous values on {unanimousRun.filled} paper{unanimousRun.filled === 1 ? '' : 's'}.
                {unanimousRun.skipped > 0 && ` ${unanimousRun.skipped} left unchanged.`}
              </span>
              <button type="button" onClick={dismissUnanimousRun}>
                Dismiss
              </button>
            </div>
          )}
          <p className="disagreement-intro">
            {total === 0
              ? 'No unresolved disagreements remain.'
              : `${total} disagreement${total === 1 ? '' : 's'} across ${papers.length} paper${papers.length === 1 ? '' : 's'}.`}
          </p>
          <div className="paper-search consolidation-overview-search">
            <input
              className="paper-search-input"
              type="text"
              placeholder="Search papers…"
              aria-label="Search papers with disagreements"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {filtered.length === 0 ? (
            <p className="paper-list-empty">
              {words.length > 0 ? 'No matching papers' : 'No papers with disagreements'}
            </p>
          ) : (
            <ul className="consolidation-overview-papers">
              {filtered.map((paper) => (
                <li key={paper.id}>
                  <button
                    type="button"
                    onClick={() => openDisagreementsFromOverview(paper.id)}
                    title="Open this paper's disagreements"
                  >
                    <span>{paper.title}</span>
                    <span>
                      {paper.disagreements} disagreement{paper.disagreements === 1 ? '' : 's'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}