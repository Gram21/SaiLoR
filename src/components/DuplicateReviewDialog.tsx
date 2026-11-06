import { useEffect } from 'react'
import { useEditorStore, type DuplicateDecision, type DuplicateReviewDraft, type EditorPaper } from '../state/editorStore'
import type { DupReason, DupVerdict } from '../model/duplicates'
import { rich, t, tp, useT } from '../i18n'
import '../styles/duplicates.css'
import { Modal } from './Modal'

/**
 * Reviewing *probable* duplicates `importReferences` found — a paper the fuzzy
 * matcher thinks is the same as one already in the project, or as another
 * entry earlier in the same file. Nothing from the import has been committed
 * yet: this is the gate between "classified" and "written", the same shape
 * `ScreeningImportDialog` uses for its own pre-commit summary.
 *
 * Backdrop-click / × / Escape all cancel, same as `ScreeningImportDialog` and
 * for the same reason: unlike `GitMergeDialog` (whose repo is genuinely
 * mid-merge while it's open), nothing here has touched the draft yet, so
 * dismissing it can't leave anything half-done. Import is gated on every row
 * being decided — the brief's "never silently merged, never silently added
 * twice" — matching `GitMergeDialog`'s "Finish merge" gate on `decidedCount`.
 */
export function DuplicateReviewDialog() {
  const t = useT()
  const draft = useEditorStore((s) => s.duplicateReview)
  const papers = useEditorStore((s) => s.papers)
  const setDuplicateDecision = useEditorStore((s) => s.setDuplicateDecision)
  const setAllDuplicateDecisions = useEditorStore((s) => s.setAllDuplicateDecisions)
  const resolveDuplicateReview = useEditorStore((s) => s.resolveDuplicateReview)

  useEffect(() => {
    if (!draft) return
    // [impl->req~dat-340~1]
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolveDuplicateReview('cancel')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [draft, resolveDuplicateReview])

  if (!draft) return null

  // `certain`/`new` entries need no decision — only a `probable` row is ever
  // shown, since those are the only ones the reviewer can do anything about.
  const rows = draft.verdicts
    .map((verdict, index) => ({ verdict, index }))
    .filter((r): r is { verdict: Extract<DupVerdict, { kind: 'probable' }>; index: number } => r.verdict.kind === 'probable')

  const decidedCount = rows.filter((r) => draft.decisions[r.index]).length
  const allDecided = decidedCount >= rows.length

  return (
    <Modal onClose={() => resolveDuplicateReview('cancel')} className="dup-review-dialog" aria-label={t('editor.duplicates.dialogLabel')}>
      <div className="modal-head">
        <strong>
          {t('editor.duplicates.heading', { source: draft.sourceName })}
          <span className="dup-review-progress">
            {t('editor.duplicates.progress', { decided: decidedCount, total: rows.length })}
          </span>
        </strong>
        <button
          type="button"
          className="icon-btn"
          title={t('editor.duplicates.cancelImportTitle')}
          onClick={() => resolveDuplicateReview('cancel')}
          aria-label={t('common.close')}
        >
          ×
        </button>
      </div>

      <div className="modal-body">
        <p>
          {rich(draft.entries.length === 1 ? 'editor.duplicates.intro_one' : 'editor.duplicates.intro_other', {
            rows: rows.length,
            count: draft.entries.length,
          })}
        </p>
        <div className="dup-review-bulk">
          <button
            type="button"
            title={t('editor.duplicates.markAllMergeTitle')}
            onClick={() => setAllDuplicateDecisions('merge')}
          >
            {t('editor.duplicates.markAllMerge')}
          </button>
          <button
            type="button"
            title={t('editor.duplicates.markAllSeparateTitle')}
            onClick={() => setAllDuplicateDecisions('separate')}
          >
            {t('editor.duplicates.markAllSeparate')}
          </button>
        </div>

        <ul className="dup-review-rows">
          {rows.map(({ verdict, index }) => (
            <DuplicateRow
              key={index}
              entry={draft.entries[index]}
              verdict={verdict}
              target={targetOf(verdict, draft, papers)}
              decision={draft.decisions[index]}
              onSet={(d) => setDuplicateDecision(index, d)}
            />
          ))}
        </ul>
      </div>

      <div className="dup-review-footer">
        <button
          type="button"
          title={t('editor.duplicates.discardTitle')}
          onClick={() => resolveDuplicateReview('cancel')}
        >
          {t('editor.duplicates.cancelImport')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!allDecided}
          title={allDecided ? t('editor.duplicates.importTitle') : t('editor.duplicates.importBlockedTitle')}
          onClick={() => resolveDuplicateReview('apply')}
        >
          {tp('editor.duplicates.importButton', draft.entries.length)}
        </button>
      </div>
      
    </Modal>
  )
}

/** What a `probable` verdict's target actually looks like, for display. An
 *  `'existing'` target reads from the live papers list — nothing else can edit
 *  the draft while this modal is open, but reading live rather than
 *  snapshotting at classification time costs nothing and needs no separate
 *  "what did paper N look like back then" copy of the data. A `'batch'`
 *  target reads from the draft's own parsed entries. `null` only if an
 *  existing target's uid has vanished, which nothing in this flow can cause. */
interface TargetInfo {
  title: string
  authors: string
  doi: string
  where: string
}

function targetOf(
  verdict: Extract<DupVerdict, { kind: 'probable' }>,
  draft: DuplicateReviewDraft,
  papers: EditorPaper[],
): TargetInfo | null {
  if (verdict.target.where === 'existing') {
    const uid = draft.existingUids[verdict.target.index]
    const paper = papers.find((p) => p.uid === uid)
    if (!paper) return null
    return { title: paper.title, authors: paper.authors, doi: paper.doi, where: t('editor.duplicates.whereExisting') }
  }
  const entry = draft.entries[verdict.target.index]
  return { title: entry.title, authors: entry.authors.join(', '), doi: entry.doi ?? '', where: t('editor.duplicates.whereBatch') }
}

function reasonLabel(reason: DupReason): string {
  if (reason.via === 'doi') return t('editor.duplicates.reasonDoi')
  if (reason.via === 'title') {
    // A `probable` (not `certain`) exact-title match only ever happens when
    // the two sides' DOIs actively disagree — see `duplicates.ts`'s
    // `classifyPair` — so a score of 1 here always means that, not a fuzzy tie.
    return reason.score >= 1
      ? t('editor.duplicates.reasonTitleDoi')
      : t('editor.duplicates.reasonTitleAlike', { pct: Math.round(reason.score * 100) })
  }
  return t('editor.duplicates.reasonMainTitle', {
    pct: Math.round(reason.score * 100),
    authors: Math.round(reason.authors * 100),
  })
}

function formatValue(value: string | undefined): string {
  if (!value || !value.trim()) return t('editor.duplicates.empty')
  return value
}

function DuplicateRow({
  entry,
  verdict,
  target,
  decision,
  onSet,
}: {
  entry: DuplicateReviewDraft['entries'][number]
  verdict: Extract<DupVerdict, { kind: 'probable' }>
  target: TargetInfo | null
  decision: DuplicateDecision | undefined
  onSet: (decision: DuplicateDecision) => void
}) {
  return (
    <li className={`dup-row${decision ? '' : ' is-undecided'}`}>
      <div className="dup-row-head">
        <span className="dup-row-reason">{reasonLabel(verdict.reason)}</span>
        {target && <span className="dup-row-where">{target.where}</span>}
        {!decision && <span className="dup-row-undecided-badge">{t('editor.duplicates.undecided')}</span>}
      </div>
      <div className="dup-row-body">
        <div className="dup-row-side" title={t('editor.duplicates.thisImport')}>
          <div className="dup-row-title">{formatValue(entry.title)}</div>
          <div className="dup-row-meta">{formatValue(entry.authors.join(', '))}</div>
          <div className="dup-row-meta">{formatValue(entry.doi)}</div>
        </div>
        <div className="dup-row-side" title={t('editor.duplicates.possibleMatch')}>
          <div className="dup-row-title">{formatValue(target?.title)}</div>
          <div className="dup-row-meta">{formatValue(target?.authors)}</div>
          <div className="dup-row-meta">{formatValue(target?.doi)}</div>
        </div>
      </div>
      <div className="dup-row-actions" role="group">
        <button
          type="button"
          className={`dup-decision-btn${decision === 'merge' ? ' active' : ''}`}
          title={t('editor.duplicates.mergeTitle')}
          onClick={() => onSet('merge')}
        >
          {t('editor.duplicates.merge')}
        </button>
        <button
          type="button"
          className={`dup-decision-btn${decision === 'separate' ? ' active' : ''}`}
          title={t('editor.duplicates.separateTitle')}
          onClick={() => onSet('separate')}
        >
          {t('editor.duplicates.separate')}
        </button>
      </div>
    </li>
  )
}
