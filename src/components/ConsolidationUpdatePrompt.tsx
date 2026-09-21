import { useEffect } from 'react'
import { useStore } from '../state/store'

/**
 * Asked when a reviewer has changed their answers on a paper the consolidator
 * has already worked on.
 *
 * Consolidation's automatic steps — matching the reviewers' repeated entries
 * and adopting the answers they all gave — are safe to repeat only while the
 * reviewers' work is unchanged. Once it has changed, re-running them can write
 * into fields the consolidator has since decided about, so the choice is put to
 * them rather than made silently. Escape keeps the consolidated version, the
 * conservative side: nothing already decided is touched.
 */
export function ConsolidationUpdatePrompt() {
  const paperId = useStore((s) => s.consolidationUpdatePrompt)
  const resolve = useStore((s) => s.resolveConsolidationUpdate)
  const title = useStore((s) => s.project?.papers.find((p) => p.id === s.consolidationUpdatePrompt)?.title)

  useEffect(() => {
    if (!paperId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolve(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [paperId, resolve])

  if (!paperId) return null

  return (
    <div className="modal-overlay" onClick={() => resolve(false)}>
      <div
        className="modal close-prompt"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <div className="modal-body">
          <h3>Reviewer answers changed on "{title}"</h3>
          <p>
            A reviewer has edited this paper since you last consolidated it. Updating re-matches their
            entries and fills unanswered consolidated fields with the answers they now agree on, which
            can undo changes you made here.
          </p>
        </div>
        <div className="close-prompt-actions">
          <button type="button" className="primary" onClick={() => resolve(false)} autoFocus>
            Keep My Version
          </button>
          <button type="button" onClick={() => resolve(true)}>
            Update
          </button>
        </div>
      </div>
    </div>
  )
}
