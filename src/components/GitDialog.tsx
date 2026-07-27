import { useEffect, useRef, useState } from 'react'
import { useGitStore } from '../state/gitStore'
import { useStore } from '../state/store'
import { diffLines } from '../git/output'
import { annotationsRelDir } from '../git/relpath'
import type { Disposition, FieldChange, PaperChange } from '../git/changes'
import type { FieldValue } from '../model/annotations'
import '../styles/git.css'

/** The branch switcher's own sentinel value for "New branch…" — never a real
 *  branch name git itself would produce, so it can share the `<select>`
 *  with `branches` without colliding. */
const NEW_BRANCH_OPTION = '__sailor_new_branch__'

/**
 * The confirm text `runPrimaryAction` must show before committing when a
 * Discard row is mixed in among Use rows — `composeContents` (git/changes.ts)
 * builds `workingOut` by reverting every Discard field to its last-committed
 * value, and `runCommit` writes that back to the file on disk unconditionally.
 * `discardOnlyMode` already has its own, separately-worded confirm for the
 * case where *every* row is Discard (nothing to commit at all); this is for
 * the mixed case, which previously reverted the field with no warning.
 * `null` means proceed without asking — no Discard row, or it's the
 * discard-only path instead.
 */
export function mixedDiscardConfirmMessage(
  discardOnlyMode: boolean,
  hasDiscardRow: boolean,
  discardCount: number,
  relPath: string,
): string | null {
  if (discardOnlyMode || !hasDiscardRow) return null
  const n = discardCount
  return (
    `${n} field${n === 1 ? '' : 's'} marked Discard will be reverted to ${n === 1 ? 'its' : 'their'} ` +
    `last-committed value in ${relPath} when this commits — ${n === 1 ? 'that change' : 'those changes'} ` +
    `will be lost, and this cannot be undone.\n\nContinue?`
  )
}

/**
 * Git — changes, a diff, a commit message, Pull, Push. Shown for the open
 * project's own repository (`useGitStore().repo`), which the Toolbar's
 * **Git** button gates on.
 *
 * The open project's own file gets field-level review (`panel.fieldReview`)
 * whenever it can — see `refreshFieldReview` in `gitStore.ts` for exactly
 * when that is. Every other changed file, and the project file itself when
 * it can't be reviewed field by field, keeps the plain whole-file checkbox
 * this dialog has always had.
 */
export function GitDialog() {
  const panel = useGitStore((s) => s.panel)
  const repo = useGitStore((s) => s.repo)
  const branches = useGitStore((s) => s.branches)
  const requestSwitchBranch = useGitStore((s) => s.requestSwitchBranch)
  const openNewBranchPrompt = useGitStore((s) => s.openNewBranchPrompt)
  const closePanel = useGitStore((s) => s.closePanel)
  const refreshStatus = useGitStore((s) => s.refreshStatus)
  const toggleSelected = useGitStore((s) => s.toggleSelected)
  const setFieldDisposition = useGitStore((s) => s.setFieldDisposition)
  const setAllFieldDispositions = useGitStore((s) => s.setAllFieldDispositions)
  const setCommitMessage = useGitStore((s) => s.setCommitMessage)
  const runCommit = useGitStore((s) => s.runCommit)
  const runDiscard = useGitStore((s) => s.runDiscard)
  const runPush = useGitStore((s) => s.runPush)
  const runPull = useGitStore((s) => s.runPull)
  const dismissPanelMessage = useGitStore((s) => s.dismissPanelMessage)

  const dirty = useStore((s) => s.dirty)
  const save = useStore((s) => s.save)

  useEffect(() => {
    if (!panel || panel.merge) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panel, closePanel])

  if (!panel || !repo) return null
  // The merge resolution dialog takes over from here — see GitMergeDialog.
  if (panel.merge) return null

  const working = panel.phase === 'working'
  const review = panel.fieldReview
  // The project's own rows — `project.json` and everything under
  // `annotations/` — live in the field-review list below instead, once
  // there is one — never both.
  const dir = annotationsRelDir(repo.relPath)
  const changes = (panel.status?.changes ?? []).filter(
    (c) => !review || (c.path !== repo.relPath && c.path !== dir && !c.path.startsWith(`${dir}/`)),
  )
  const selectedCount = Object.keys(panel.selected).length
  const hasUntracked = changes.some((c) => c.code === '??')
  const reviewRowCount = review ? review.changes.fields.length + review.changes.papers.length : 0

  // What the review's rows actually resolve to (absent means 'use', the same
  // default `composeContents` itself applies) — what decides whether the
  // primary button below has anything to *commit* at all.
  const reviewDispositions = review
    ? [...review.changes.papers, ...review.changes.fields].map((r) => review.decisions[r.id] ?? 'use')
    : []
  const hasUseRow = reviewDispositions.includes('use')
  const hasDiscardRow = reviewDispositions.includes('discard')
  // No other file is selected, and nothing in the review would end up
  // committed — every row is Ignore or Discard. Committing would write
  // nothing new, so the button's only honest job left is discarding.
  const discardOnlyMode = !!review && selectedCount === 0 && !hasUseRow && hasDiscardRow
  // The same state, minus a row actually marked Discard — every reviewed row
  // is Ignore, and nothing else is selected. There is genuinely nothing to
  // do: not a commit (nothing changed), not a discard (nothing marked).
  const nothingPending = !!review && selectedCount === 0 && !hasUseRow && !hasDiscardRow

  const requestClose = () => closePanel()

  const runPrimaryAction = () => {
    if (!discardOnlyMode) {
      const discardCount = reviewDispositions.filter((d) => d === 'discard').length
      const msg = mixedDiscardConfirmMessage(discardOnlyMode, hasDiscardRow, discardCount, repo.relPath)
      if (msg && !window.confirm(msg)) return
      void runCommit()
      return
    }
    const n = reviewDispositions.filter((d) => d === 'discard').length
    const ok = window.confirm(
      `Discard ${n} change${n === 1 ? '' : 's'} in ${repo.relPath}? This reverts ` +
        `${n === 1 ? 'it' : 'them'} in the file on disk and cannot be undone. Nothing is committed.`,
    )
    if (ok) void runDiscard()
  }

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div
        className="modal git-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Git"
      >
        <div className="modal-head">
          <strong>
            Git —{' '}
            {repo.branch && branches.length > 0 ? (
              <select
                className="git-branch-select"
                aria-label="Switch branch"
                value={repo.branch}
                disabled={working}
                onChange={(e) => {
                  if (e.target.value === NEW_BRANCH_OPTION) openNewBranchPrompt()
                  else requestSwitchBranch(e.target.value)
                }}
              >
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
                <option value={NEW_BRANCH_OPTION}>+ New branch…</option>
              </select>
            ) : (
              (repo.branch ?? 'detached HEAD')
            )}
            <span className="git-upstream"> ▸ {repo.upstream ?? 'no upstream'}</span>
          </strong>
          <button type="button" className="icon-btn" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {dirty && (
            <div className="git-dirty-banner">
              You have unsaved annotations. Commit and pull work on the file on disk, so save first.
              <button type="button" onClick={() => void save()}>
                Save project
              </button>
            </div>
          )}

          {review && (
            <>
              <div className="git-changes-head">
                <strong>Your changes to {repo.relPath} ({reviewRowCount})</strong>
                <button type="button" className="icon-btn" title="Refresh" onClick={() => void refreshStatus()}>
                  ↻
                </button>
              </div>
              <p className="git-muted">
                Use commits a field's new value. Ignore leaves it as an uncommitted change, offered
                again next time. Discard reverts it back to the committed value once you press the
                button below — Commit if anything is still marked Use, or Discard all if everything
                left is Ignore or Discard.
              </p>
              <div className="git-field-review-bulk">
                <button type="button" onClick={() => setAllFieldDispositions('use')}>
                  Use all
                </button>
                <button type="button" onClick={() => setAllFieldDispositions('ignore')}>
                  Ignore all
                </button>
                <button type="button" onClick={() => setAllFieldDispositions('discard')}>
                  Discard all
                </button>
              </div>
              <ul className="git-field-rows">
                {review.changes.papers.map((pc) => (
                  <PaperChangeRow
                    key={pc.id}
                    change={pc}
                    disposition={review.decisions[pc.id] ?? 'use'}
                    onSet={(d) => setFieldDisposition(pc.id, d)}
                  />
                ))}
                {review.changes.fields.map((fc) => (
                  <FieldChangeRow
                    key={fc.id}
                    change={fc}
                    disposition={review.decisions[fc.id] ?? 'use'}
                    onSet={(d) => setFieldDisposition(fc.id, d)}
                  />
                ))}
              </ul>
            </>
          )}

          <div className="git-changes-head">
            <strong>{review ? `Other changes (${changes.length})` : `Changes (${changes.length})`}</strong>
            {!review && (
              <button type="button" className="icon-btn" title="Refresh" onClick={() => void refreshStatus()}>
                ↻
              </button>
            )}
          </div>

          {panel.phase === 'loading' ? (
            <p className="git-muted">Reading status…</p>
          ) : changes.length === 0 ? (
            <p className="git-muted">
              {review ? 'Nothing else has changed.' : 'Nothing has changed since the last commit.'}
            </p>
          ) : (
            <ul className="git-changes">
              {changes.map((c) => (
                <li key={c.path} className="git-change-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={!!panel.selected[c.path]}
                      onChange={() => toggleSelected(c.path)}
                    />
                    <span className="git-change-code">{c.code}</span>
                    <span className="git-change-path">
                      {c.from ? `${c.from} → ${c.path}` : c.path}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {panel.status?.diff && (
            <details className="git-diff-details">
              <summary>{review ? 'Raw diff (advanced)' : 'Diff'}</summary>
              <pre className="git-diff">
                {diffLines(panel.status.diff).map((line, i) => (
                  // Index is safe here: this list is a pure function of the diff
                  // text and re-renders wholesale whenever it changes, never
                  // reordered or edited in place.
                  <span key={i} className={`git-diff-line git-diff-${line.kind}`}>
                    {line.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </details>
          )}
          {panel.status?.diffTruncated && <p className="git-muted">Diff truncated.</p>}
          {hasUntracked && <p className="git-muted">Untracked files have no diff yet.</p>}

          <label className="git-field-label" htmlFor="git-commit-message">
            Commit message
          </label>
          <CommitMessageField value={panel.message} onChange={setCommitMessage} />

          <div className="git-panel-actions">
            <button
              type="button"
              className={`primary${discardOnlyMode ? ' danger' : ''}`}
              title={nothingPending ? 'Nothing to commit or discard — every reviewed field is set to Ignore.' : undefined}
              disabled={
                working ||
                dirty ||
                (selectedCount === 0 && !review) ||
                nothingPending ||
                (!discardOnlyMode && !panel.message.trim())
              }
              onClick={runPrimaryAction}
            >
              {discardOnlyMode ? 'Discard all' : 'Commit'}
            </button>
            <div className="git-panel-actions-right">
              <button type="button" disabled={working || dirty || !repo.upstream} onClick={() => void runPull()}>
                Pull
              </button>
              <button type="button" disabled={working} onClick={() => void runPush()}>
                Push
              </button>
            </div>
          </div>

          {(panel.error || panel.notice) && (
            <div className={panel.error ? 'git-message git-message-error' : 'git-message git-message-notice'}>
              <pre className="git-message-text">{panel.error ?? panel.notice}</pre>
              <button type="button" className="icon-btn" onClick={dismissPanelMessage} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Capped at the same height `Field.tsx`'s `StringField` uses for an annotation
 *  text field — a commit message deserves the identical collapsed-until-focus
 *  feel, not a different number that happens to also look reasonable. */
const MAX_MESSAGE_HEIGHT = 240

/** Single-line when idle, grows downward (capped) while focused — same pattern
 *  as an annotation text field, and, unlike the plain `<input>` this replaces,
 *  wide enough to actually use the dialog's own width (see `.git-commit-message`
 *  in git.css: a bare `.field-input` has no width outside a flex row). */
function CommitMessageField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [expanded, setExpanded] = useState(false)

  const resize = () => {
    const el = ref.current
    if (!el) return
    if (!expanded) {
      el.style.height = ''
      return
    }
    // Reset first so scrollHeight reflects the content, not the current box.
    el.style.height = ''
    el.style.height = `${Math.min(el.scrollHeight, MAX_MESSAGE_HEIGHT)}px`
  }

  useEffect(resize, [expanded, value])

  return (
    <textarea
      ref={ref}
      id="git-commit-message"
      rows={1}
      className={`field-input field-textarea git-commit-message${expanded ? ' expanded' : ''}`}
      value={value}
      placeholder="Describe what changed…"
      onFocus={() => setExpanded(true)}
      onBlur={() => {
        setExpanded(false)
        if (ref.current) ref.current.style.height = ''
      }}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** Matching `GitMergeDialog.tsx`'s own `formatValue` — not shared from there
 *  on purpose (see that file's comment): this dialog stays free to diverge
 *  in how it renders a value without one quietly depending on the other's
 *  private helper. */
function formatValue(value: FieldValue): string {
  if (value === undefined || value === null) return '— empty —'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' && value.trim() === '') return '— empty —'
  return String(value)
}

interface DispositionButtonsProps {
  disposition: Disposition
  onSet: (d: Disposition) => void
}

/**
 * Use/Ignore grouped on the left, Discard alone on the right — a discard is a
 * different kind of decision from the other two (it reverts a local edit
 * rather than choosing what to do with it), and `.git-field-row-actions`'
 * `justify-content: space-between` is what pushes it there: two flex
 * children, the group and the lone button, pinned to opposite ends of the row.
 */
function DispositionButtons({ disposition, onSet }: DispositionButtonsProps) {
  return (
    <div className="git-field-row-actions" role="group">
      <div className="git-disposition-group">
        <button
          type="button"
          className={`git-disposition-btn${disposition === 'use' ? ' active' : ''}`}
          title="Commit this change"
          onClick={() => onSet('use')}
        >
          Use
        </button>
        <button
          type="button"
          className={`git-disposition-btn${disposition === 'ignore' ? ' active' : ''}`}
          title="Leave this as an uncommitted change, offered again next time"
          onClick={() => onSet('ignore')}
        >
          Ignore
        </button>
      </div>
      <button
        type="button"
        className={`git-disposition-btn git-disposition-discard${disposition === 'discard' ? ' active' : ''}`}
        title="Revert this change once you press Commit (or Discard all, below)"
        onClick={() => onSet('discard')}
      >
        Discard
      </button>
    </div>
  )
}

function FieldChangeRow({
  change,
  disposition,
  onSet,
}: {
  change: FieldChange
  disposition: Disposition
  onSet: (d: Disposition) => void
}) {
  return (
    <li className={`git-field-row${disposition === 'discard' ? ' is-discard' : ''}`}>
      <div className="git-field-row-head">
        <span className="git-field-row-paper">{change.paperTitle}</span>
        <span className="git-field-row-label">{change.label}</span>
      </div>
      <div className="git-field-row-values">
        <span className="git-field-row-was" title="Committed value">
          Was: {formatValue(change.headValue)}
        </span>
        <span className="git-field-row-now" title="Working copy's value">
          Now: {formatValue(change.workingValue)}
        </span>
      </div>
      <DispositionButtons disposition={disposition} onSet={onSet} />
    </li>
  )
}

function PaperChangeRow({
  change,
  disposition,
  onSet,
}: {
  change: PaperChange
  disposition: Disposition
  onSet: (d: Disposition) => void
}) {
  return (
    <li className={`git-field-row${disposition === 'discard' ? ' is-discard' : ''}`}>
      <div className="git-field-row-head">
        <span className="git-field-row-label">
          {change.kind === 'added' ? 'Paper added' : 'Paper removed'}: {change.paperTitle}
        </span>
      </div>
      <DispositionButtons disposition={disposition} onSet={onSet} />
    </li>
  )
}
