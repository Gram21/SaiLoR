import { useState } from 'react'
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
  const history = useGitStore((s) => s.panel?.history ?? null)
  const closeHistory = useGitStore((s) => s.closeHistory)
  const loadCommitDiff = useGitStore((s) => s.loadCommitDiff)

  // Manual open/closed state, keyed by commit hash — mirrors GitMergeDialog's
  // own `collapsed` state, minus its auto-collapse-on-completion effect: a
  // history row has no "done" state to collapse toward.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  if (!history) return null

  const toggle = (hash: string) => {
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
        aria-label="Commit history"
      >
        <div className="modal-head">
          <strong>History</strong>
          <button type="button" className="icon-btn" onClick={closeHistory} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {history.error && <p className="git-message-text git-message-error">{history.error}</p>}
          {!history.error && history.commits.length === 0 && (
            <p className="git-muted">Nothing has been committed to this file yet.</p>
          )}
          <ul className="git-history-rows">
            {history.commits.map((c) => (
              <li key={c.hash} className="git-history-row">
                <button
                  type="button"
                  className="git-history-row-head"
                  aria-expanded={!!expanded[c.hash]}
                  onClick={() => toggle(c.hash)}
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
          {history.truncated && (
            <p className="git-muted">Showing the latest {history.commits.length} commits — use git log for more.</p>
          )}
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
  return Number.isNaN(d.getTime()) ? date : d.toLocaleString()
}

function CommitDiff({ result }: { result: LogDiffResult | 'loading' | undefined }) {
  if (result === undefined || result === 'loading') {
    return <p className="git-muted git-history-diff">Loading…</p>
  }
  if (result.kind === 'initial') {
    return <p className="git-muted git-history-diff">Initial commit — nothing to compare.</p>
  }
  if (result.kind === 'error') {
    return <p className="git-message-text git-message-error git-history-diff">{result.message}</p>
  }
  if (result.kind === 'structural') {
    return (
      <p className="git-muted git-history-diff">
        The schema, protocol, or another structural field changed in this commit — no field-level diff available.
      </p>
    )
  }

  const { fields, papers } = result.changes
  if (fields.length === 0 && papers.length === 0) {
    return <p className="git-muted git-history-diff">No annotation changes in this commit.</p>
  }

  return (
    <ul className="git-field-rows git-history-diff">
      {papers.map((pc) => (
        <li key={pc.id} className="git-field-row">
          <div className="git-field-row-head">
            <span className="git-field-row-label">
              {pc.kind === 'added' ? 'Paper added' : 'Paper removed'}: {pc.paperTitle}
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
            <span className="git-field-row-was" title="Before this commit">
              Was: {formatValue(fc.headValue)}
            </span>
            <span className="git-field-row-now" title="After this commit">
              Now: {formatValue(fc.workingValue)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}
