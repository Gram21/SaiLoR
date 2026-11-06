// [impl->req~con-257~1]
import { useEffect } from 'react'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import { Modal } from './Modal'

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
  const t = useT()
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
    <Modal onClose={() => resolve(false)} className="close-prompt" role="alertdialog">
      <div className="modal-body">
        <h3>{t('consolidation.updatePrompt.title', { title: title ?? '' })}</h3>
        <p>{t('consolidation.updatePrompt.body')}</p>
      </div>
      <div className="close-prompt-actions">
        <button
          type="button"
          className="primary"
          onClick={() => resolve(false)}
          autoFocus
          title={t('consolidation.updatePrompt.keepTitle')}
        >
          {t('consolidation.updatePrompt.keep')}
        </button>
        <button
          type="button"
          onClick={() => resolve(true)}
          title={t('consolidation.updatePrompt.updateTitle')}
        >
          {t('consolidation.updatePrompt.update')}
        </button>
      </div>
      
    </Modal>
  )
}
