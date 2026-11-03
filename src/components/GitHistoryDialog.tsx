import { useState } from 'react'
import { useT, getLanguage } from '../i18n'
import { useGitStore, type LogDiffResult } from '../state/gitStore'
import { formatValue } from './GitDialog'
import '../styles/git.css'

/**
 * The "History…" button's dialog — `git log` scoped to the open project's own
 * file, one row per commit, with an on-demand field-level diff per row (see
 * `openHistory`/`loadCommitDiff` in `gitStore.ts` for why the diff is lazy and
 * cached rather than fetched for the whole list at once).
 *
 * Read-only throughout: this is a history viewer, not a review queue, so rows
 * render `formatValue`'s Was/Now text without any Use/Ignore/Discard controls.
 */
export function GitHistoryDialog() {
  const t = useT()
  const history = useGitStore((s) => s.panel?.history ?? null)
  const closeHistory = useGitStore((s) => s.closeHistory)
  const loadCommitDiff = useGitStore((s) => s.loadCommitDiff)

  // Manual open/closed state, keyed by commit hash — mirrors GitMergeDialog's
  // own `collapsed` state, minus its auto-collapse-on-completion effect: a
  // history row has no "done" state to collapse toward.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  if (!history) return null

  const toggle = (hash: string) => {
    // [impl->req~git-370~1]
    const next = !expanded[hash]
    setExpanded((prev) => ({ ...prev, [hash]: next }))
    if (next) void loadCommitDiff(hash)
  }

  return (
    <div className="modal-overlay" onClick={closeHistory}>
      <div
        className="modal git-merge-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('git.history.label')}
      >
        <div className="modal-head">
          <strong>{t('git.dialog.history')}</strong>
          <button
            type="button"
            className="icon-btn"
            onClick={closeHistory}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            ×
          </button>
        </div>

        <div className="modal-body">
          {history.error && <p className="git-message-text git-message-error">{history.error}</p>}
          {!history.error && history.commits.length === 0 && (
            <p className="git-muted">{t('git.history.empty')}</p>
          )}
          <ul className="git-history-rows">
            {history.commits.map((c) => (
              <li key={c.hash} className="git-history-row">
                <button
                  type="button"
                  className="git-history-row-head"
                  aria-expanded={!!expanded[c.hash]}
                  onClick={() => toggle(c.hash)}
                  title={expanded[c.hash] ? t('git.history.hideDiff') : t('git.history.showDiff')}
                >
                  <span className={`git-merge-group-chevron${expanded[c.hash] ? '' : ' is-collapsed'}`} aria-hidden="true">
                    ▾
                  </span>
                  <span className="git-history-date">{formatCommitDate(c.date)}</span>
                  <span className="git-history-subject">{c.subject}</span>
                  <span className="git-history-hash">{c.hash.slice(0, 7)}</span>
                </button>
                {expanded[c.hash] && <CommitDiff result={history.diffs[c.hash]} />}
              </li>
            ))}
          </ul>
          {history.truncated && <p className="git-muted">{t('git.history.truncated', { count: history.commits.length })}</p>}
        </div>
      </div>
    </div>
  )
}

/** `date` is ISO 8601 (`--date=iso-strict`) — shown in the reviewer's own
 *  locale rather than verbatim, the same as every other timestamp this app
 *  displays. Falls back to the raw string on a date this browser can't parse
 *  rather than showing nothing. */
function formatCommitDate(date: string): string {
  const d = new Date(date)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleString(getLanguage())
}

function CommitDiff({ result }: { result: LogDiffResult | 'loading' | undefined }) {
  const t = useT()
  if (result === undefined || result === 'loading') {
    return <p className="git-muted git-history-diff">{t('common.loading')}</p>
  }
  if (result.kind === 'initial') {
    return <p className="git-muted git-history-diff">{t('git.history.initial')}</p>
  }
  if (result.kind === 'error') {
    return <p className="git-message-text git-message-error git-history-diff">{result.message}</p>
  }
  if (result.kind === 'structural') {
    return <p className="git-muted git-history-diff">{t('git.history.structural')}</p>
  }

  const { fields, papers } = result.changes
  if (fields.length === 0 && papers.length === 0) {
    return <p className="git-muted git-history-diff">{t('git.history.noChanges')}</p>
  }

  return (
    <ul className="git-field-rows git-history-diff">
      {papers.map((pc) => (
        <li key={pc.id} className="git-field-row">
          <div className="git-field-row-head">
            <span className="git-field-row-label">
              {pc.kind === 'added' ? t('git.paper.added') : t('git.paper.removed')}: {pc.paperTitle}
            </span>
          </div>
        </li>
      ))}
      {fields.map((fc) => (
        <li key={fc.id} className="git-field-row">
          <div className="git-field-row-head">
            <span className="git-field-row-paper">{fc.paperTitle}</span>
            <span className="git-field-row-label">{fc.label}</span>
          </div>
          <div className="git-field-row-values">
            <span className="git-field-row-was" title={t('git.history.beforeCommit')}>
              {t('git.field.was')}: {formatValue(fc.headValue)}
            </span>
            <span className="git-field-row-now" title={t('git.history.afterCommit')}>
              {t('git.field.now')}: {formatValue(fc.workingValue)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}
