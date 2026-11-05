// [impl->req~git-540~1]
import { useEffect, useRef, useState } from 'react'
import { useT, t, tp } from '../i18n'
import { useGitStore } from '../state/gitStore'
import { useStore } from '../state/store'
import { diffLines } from '../git/output'
import { annotationsRelDir } from '../git/relpath'
import { isFeedbackPath } from '../model/annotationsDir'
import { papersWithBookkeepingChanges } from '../git/changes'
import type { Disposition, FieldChange, PaperChange } from '../git/changes'
import type { FieldValue } from '../model/annotations'
import { GitStashSection } from './GitStashSection'
import '../styles/git.css'

/** Sentinel for "New branch…" in the branch `<select>` — never a real branch name. */
const NEW_BRANCH_OPTION = '__sailor_new_branch__'

/** Sentinel for "- Delete branch…" — same trick as `NEW_BRANCH_OPTION`. */
const DELETE_BRANCH_OPTION = '__sailor_delete_branch__'

/**
 * Confirm text for committing while a Discard row is mixed in among Use rows —
 * `composeContents` reverts every Discard field and `runCommit` writes that to
 * disk unconditionally, previously with no warning. `null` means proceed
 * without asking (no Discard row, or the discard-only path handles it instead).
 */
export function mixedDiscardConfirmMessage(
  discardOnlyMode: boolean,
  hasDiscardRow: boolean,
  fieldDiscardCount: number,
  paperDiscardCount: number,
  relPath: string,
): string | null {
  if (discardOnlyMode || !hasDiscardRow) return null

  // Field-only wording, kept byte-for-byte from before `paperDiscardCount` existed.
  if (paperDiscardCount === 0) {
    return tp('git.dialog.discardFields', fieldDiscardCount, { path: relPath })
  }

  // A `PaperChange` marked Discard deletes the paper and all its annotation
  // files, not just "a field" — worth its own sentence rather than folding
  // into the old shared count.
  const paperPart = tp('git.dialog.discardPapers', paperDiscardCount)
  if (fieldDiscardCount === 0) {
    return t('git.dialog.discardPapersConfirm', { paper: paperPart })
  }
  const fieldPart = tp('git.dialog.discardFieldsPart', fieldDiscardCount, { path: relPath })
  return t('git.dialog.discardPapersAndFieldsConfirm', { paper: paperPart, fields: fieldPart })
}

/**
 * Is `path` the open project's own tracked file, or under its `annotations/`
 * folder? Independent of whether field review is currently available (review
 * is routinely absent, e.g. a marks-only edit); those rows then fall back to
 * the plain whole-file checkbox instead, but never get the per-file ↺ — there
 * is no committed copy of an untracked annotation file to recover from.
 * Exported for `GitDialog.test.ts`; real enforcement is server-side in
 * `git:discardFile`.
 */
export function isProjectOwnPath(path: string, relPath: string, dir: string = annotationsRelDir(relPath)): boolean {
  return path === relPath || path === dir || path.startsWith(`${dir}/`)
}

/**
 * Git — changes, a diff, a commit message, Pull, Push. Shown for the open
 * project's own repository (`useGitStore().repo`).
 *
 * The project's own file gets field-level review (`panel.fieldReview`)
 * whenever `refreshFieldReview` (gitStore.ts) makes one available; otherwise
 * it keeps the plain whole-file checkbox, like every other changed file.
 */
export function GitDialog() {
  const t = useT()
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
  const setAmend = useGitStore((s) => s.setAmend)
  const runCommit = useGitStore((s) => s.runCommit)
  const runDiscard = useGitStore((s) => s.runDiscard)
  const runPush = useGitStore((s) => s.runPush)
  const runPull = useGitStore((s) => s.runPull)
  const runUndoMerge = useGitStore((s) => s.runUndoMerge)
  const openMergeBranchPrompt = useGitStore((s) => s.openMergeBranchPrompt)
  const openDeleteBranchPrompt = useGitStore((s) => s.openDeleteBranchPrompt)
  const openHistory = useGitStore((s) => s.openHistory)
  const runDiscardFile = useGitStore((s) => s.runDiscardFile)
  const dismissPanelMessage = useGitStore((s) => s.dismissPanelMessage)

  const dirty = useStore((s) => s.dirty)
  const save = useStore((s) => s.save)

  useEffect(() => {
    // A nested overlay owns Escape while open — otherwise this listener would
    // also fire and closePanel() away the commit message and dispositions.
    if (
      !panel ||
      panel.merge ||
      panel.branchSwitchPrompt ||
      panel.newBranchPrompt ||
      panel.mergeBranchPrompt ||
      panel.deleteBranchPrompt ||
      panel.history
    )
      return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panel, closePanel])

  if (!panel || !repo) return null
  // The merge resolution dialog takes over from here — see GitMergeDialog.
  if (panel.merge) return null
  // Ditto for the delete-branch confirm and the history panel.
  if (panel.deleteBranchPrompt) return null
  if (panel.history) return null

  const working = panel.phase === 'working'
  const review = panel.fieldReview
  // The project's own rows live in the field-review list below when there is
  // one; otherwise they fall back to the plain checkbox (see `isProjectOwnPath`).
  const changes = (panel.status?.changes ?? []).filter(
    // Feedback files are plain files: field review never covers them.
    (c) => !review || !isProjectOwnPath(c.path, repo.relPath, repo.annotationsDir) || isFeedbackPath(c.path.slice(repo.annotationsDir.length + 1)),
  )
  // The switcher only ever offers local branches — checking out a
  // remote-tracking ref would detach HEAD. The merge picker takes both.
  const localBranches = branches.filter((b) => !b.remote)
  const mergeable = branches.filter((b) => !b.current)
  const selectedCount = Object.keys(panel.selected).length
  const hasUntracked = changes.some((c) => c.code === '??')
  const reviewRowCount = review ? review.changes.fields.length + review.changes.papers.length : 0
  const bookkeepingPapers = review ? papersWithBookkeepingChanges(review.head, review.working) : []

  // What the review's rows resolve to (absent means 'use', same default as `composeContents`).
  const reviewDispositions = review
    ? [...review.changes.papers, ...review.changes.fields].map((r) => review.decisions[r.id] ?? 'use')
    : []
  const hasUseRow = reviewDispositions.includes('use')
  const hasDiscardRow = reviewDispositions.includes('discard')
  // Separate counts for `mixedDiscardConfirmMessage` — a discarded paper isn't "a field".
  const paperDiscardCount = review
    ? review.changes.papers.filter((p) => (review.decisions[p.id] ?? 'use') === 'discard').length
    : 0
  const fieldDiscardCount = review
    ? review.changes.fields.filter((f) => (review.decisions[f.id] ?? 'use') === 'discard').length
    : 0
  // Nothing else selected and every review row is Ignore or Discard — nothing to commit.
  const discardOnlyMode = !!review && selectedCount === 0 && !hasUseRow && hasDiscardRow
  // Same, but no row is even marked Discard — genuinely nothing pending either way.
  const nothingPending = !!review && selectedCount === 0 && !hasUseRow && !hasDiscardRow

  const requestClose = () => closePanel()

  const runPrimaryAction = () => {
    if (!discardOnlyMode) {
      const msg = mixedDiscardConfirmMessage(discardOnlyMode, hasDiscardRow, fieldDiscardCount, paperDiscardCount, repo.relPath)
      if (msg && !window.confirm(msg)) return
      if (
        panel.amend &&
        !window.confirm(t('git.dialog.amendConfirm'))
      ) {
        return
      }
      void runCommit()
      return
    }
    const n = reviewDispositions.filter((d) => d === 'discard').length
    // Same reasoning as `mixedDiscardConfirmMessage`: a discarded paper deletes files, not just reverts a value.
    const msg =
      paperDiscardCount > 0
        ? tp('git.dialog.discardOnly.withPapers', n, {
            path: repo.relPath,
            papers: tp('git.dialog.discardOnly.papers', paperDiscardCount),
          })
        : tp('git.dialog.discardOnly.plain', n, { path: repo.relPath })
    if (window.confirm(msg)) void runDiscard()
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
            {repo.branch && localBranches.length > 0 ? (
              <select
                className="git-branch-select"
                aria-label={t('git.dialog.switchBranch')}
                value={repo.branch}
                disabled={working}
                onChange={(e) => {
                  if (e.target.value === NEW_BRANCH_OPTION) openNewBranchPrompt()
                  else if (e.target.value === DELETE_BRANCH_OPTION) openDeleteBranchPrompt()
                  else requestSwitchBranch(e.target.value)
                }}
              >
                {localBranches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
                <option value={NEW_BRANCH_OPTION}>{t('git.dialog.newBranchOption')}</option>
                {localBranches.some((b) => !b.current) && (
                  <option value={DELETE_BRANCH_OPTION}>{t('git.dialog.deleteBranchOption')}</option>
                )}
              </select>
            ) : (
              (repo.branch ?? t('git.common.detachedHead'))
            )}
            <span className="git-upstream"> ▸ {repo.upstream ?? t('git.dialog.noUpstream')}</span>
          </strong>
          <div className="modal-head-actions">
            {mergeable.length > 0 && (
              <button
                type="button"
                className="git-header-action-btn"
                title={t('git.dialog.mergeBranchTitle')}
                disabled={working || dirty}
                onClick={openMergeBranchPrompt}
              >
                {t('git.dialog.mergeBranch')}
              </button>
            )}
            <button
              type="button"
              className="git-header-action-btn"
              title={t('git.dialog.historyTitle', { path: repo.relPath })}
              disabled={working}
              onClick={() => void openHistory()}
            >
              {t('git.dialog.history')}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={requestClose}
              title={t('common.close')}
              aria-label={t('common.close')}
            >
              ×
            </button>
          </div>
        </div>

        <div className="modal-body">
          {dirty && (
            <div className="git-dirty-banner">
              {t('git.dialog.dirtyBanner')}
              <button type="button" onClick={() => void save()} title={t('git.dialog.saveProjectTitle')}>
                {t('git.dialog.saveProject')}
              </button>
            </div>
          )}

          <label className="git-field-label" htmlFor="git-commit-message">
            {t('git.dialog.commitMessage')}
          </label>
          <CommitMessageField value={panel.message} onChange={setCommitMessage} />
          <label className="git-amend-checkbox">
            <input
              type="checkbox"
              checked={panel.amend}
              disabled={working || dirty}
              onChange={(e) => void setAmend(e.target.checked)}
            />
            {t('git.dialog.amendPrevious')}
          </label>

          <div className="git-panel-actions">
            <button
              type="button"
              className={`primary${discardOnlyMode ? ' danger' : ''}`}
              title={nothingPending ? t('git.dialog.nothingPendingTitle') : undefined}
              disabled={
                working ||
                dirty ||
                (selectedCount === 0 && !review) ||
                nothingPending ||
                (!discardOnlyMode && !panel.message.trim())
              }
              onClick={runPrimaryAction}
            >
              {discardOnlyMode ? t('git.dialog.discardAll') : panel.amend ? 'Amend' : 'Commit'}
            </button>
            <div className="git-panel-actions-right">
              <button
                type="button"
                disabled={working || dirty || !repo.upstream}
                onClick={() => void runPull((summary) => window.confirm(summary))}
                title={t('git.dialog.pullTitle')}
              >
                Pull
              </button>
              <button
                type="button"
                disabled={working || dirty}
                onClick={() => {
                  // [impl->req~git-190~1]
                  // [impl->req~git-490~1]
                  const ok = window.confirm(t('git.dialog.undoMergeConfirm'))
                  if (ok) void runUndoMerge()
                }}
                title={t('git.dialog.undoMergeTitle')}
              >
                {t('git.dialog.undoMerge')}
              </button>
              <button
                type="button"
                disabled={working}
                onClick={() => void runPush()}
                title={t('git.dialog.pushTitle')}
              >
                Push
              </button>
            </div>
          </div>

          {review && (
            <>
              <div className="git-changes-head">
                <strong>{t('git.dialog.yourChanges', { path: repo.relPath, count: reviewRowCount })}</strong>
                <button type="button" className="icon-btn" title={t('git.dialog.refresh')} onClick={() => void refreshStatus()}>
                  ↻
                </button>
              </div>
              <p className="git-muted">{t('git.dialog.reviewExplanation')}</p>
              {/* These have no row of their own and are carried regardless of
                  what is decided above (see `BOOKKEEPING_FIELDS`), so the one
                  thing this list must not be is invisible. */}
              {bookkeepingPapers.length > 0 && (
                <p className="git-muted">{tp('git.dialog.bookkeeping', bookkeepingPapers.length)}</p>
              )}
              <div className="git-field-review-bulk">
                <button type="button" onClick={() => setAllFieldDispositions('use')} title={t('git.dialog.useAllTitle')}>
                  {t('git.dialog.useAll')}
                </button>
                <button type="button" onClick={() => setAllFieldDispositions('ignore')} title={t('git.dialog.ignoreAllTitle')}>
                  {t('git.dialog.ignoreAll')}
                </button>
                <button type="button" onClick={() => setAllFieldDispositions('discard')} title={t('git.dialog.discardAllTitle')}>
                  {t('git.dialog.discardAll')}
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
            <strong>
              {review
                ? t('git.dialog.otherChanges', { count: changes.length })
                : t('git.dialog.changes', { count: changes.length })}
            </strong>
            {!review && (
              <button type="button" className="icon-btn" title={t('git.dialog.refresh')} onClick={() => void refreshStatus()}>
                ↻
              </button>
            )}
          </div>

          {panel.phase === 'loading' ? (
            <p className="git-muted">{t('git.dialog.readingStatus')}</p>
          ) : changes.length === 0 ? (
            <p className="git-muted">
              {review ? t('git.dialog.nothingElseChanged') : t('git.dialog.nothingChanged')}
            </p>
          ) : (
            <ul className="git-changes">
              {changes.map((c) => {
                // Own project files never get this button (see `isProjectOwnPath`); `git:discardFile` enforces it server-side too.
                const isOwn = isProjectOwnPath(c.path, repo.relPath, repo.annotationsDir)
                // `git status --porcelain` reports an untracked dir as one record, e.g. `?? exports/`.
                const isDir = c.path.endsWith('/')
                // A rename needs more than one `checkout` to undo, and an unresolved conflict has no single well-defined "discard".
                const discardable = !isOwn && !c.from && !c.unmerged
                const untracked = c.code.startsWith('?')
                const discard = () => {
                  // [impl->req~git-190~1]
                  const ok = window.confirm(
                    untracked
                      ? isDir
                        ? t('git.dialog.deleteUntrackedFolderConfirm', { path: c.path })
                        : t('git.dialog.deleteUntrackedFileConfirm', { path: c.path })
                      : t('git.dialog.discardFileConfirm', { path: c.path }),
                  )
                  if (ok) void runDiscardFile(c.path)
                }
                const title = isOwn
                  ? t('git.dialog.ownFileTitle')
                  : discardable
                    ? untracked
                      ? isDir
                        ? t('git.dialog.deleteUntrackedFolderTitle')
                        : t('git.dialog.deleteUntrackedFileTitle')
                      : t('git.dialog.discardFileTitle')
                    : t('git.dialog.notDiscardableTitle')
                return (
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
                    <button
                      type="button"
                      className="icon-btn"
                      title={title}
                      aria-label={
                        isOwn
                          ? t('git.dialog.cannotDiscardHere', { path: c.path })
                          : untracked
                            ? t('git.dialog.deletePath', { path: c.path })
                            : t('git.dialog.discardPath', { path: c.path })
                      }
                      disabled={working || !discardable}
                      onClick={discard}
                    >
                      ↺
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {panel.status?.diff && (
            <details className="git-diff-details">
              <summary>{review ? t('git.dialog.rawDiff') : t('git.dialog.diff')}</summary>
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
          {panel.status?.diffTruncated && <p className="git-muted">{t('git.dialog.diffTruncated')}</p>}
          {hasUntracked && <p className="git-muted">{t('git.dialog.untrackedNoDiff')}</p>}

          <GitStashSection disabled={working || !!panel.merge} />

          {(panel.error || panel.notice) && (
            <div className={panel.error ? 'git-message git-message-error' : 'git-message git-message-notice'}>
              <pre className="git-message-text">{panel.error ?? panel.notice}</pre>
              <button
                type="button"
                className="icon-btn"
                onClick={dismissPanelMessage}
                title={t('git.dialog.dismissMessageTitle')}
                aria-label={t('git.common.dismiss')}
              >
                ×
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Matches `Field.tsx`'s `StringField` cap, for the same collapsed-until-focus feel. */
const MAX_MESSAGE_HEIGHT = 240

/** Single-line when idle, grows downward (capped) while focused — same pattern as
 *  an annotation text field. Unlike the plain `<input>` it replaces, needs
 *  `.git-commit-message` in git.css since `.field-input` alone has no width outside a flex row. */
function CommitMessageField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT()
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
      placeholder={t('git.dialog.commitPlaceholder')}
      onFocus={() => setExpanded(true)}
      onBlur={() => {
        setExpanded(false)
        if (ref.current) ref.current.style.height = ''
      }}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** Deliberately not shared with `GitMergeDialog.tsx`'s own `formatValue` (see that
 *  file's comment), so the two stay free to diverge. Exported for `GitHistoryDialog`. */
export function formatValue(value: FieldValue): string {
  if (value === undefined || value === null) return t('git.dialog.empty')
  if (typeof value === 'boolean') return value ? t('git.dialog.yes') : t('git.dialog.no')
  if (typeof value === 'string' && value.trim() === '') return t('git.dialog.empty')
  return String(value)
}

interface DispositionButtonsProps {
  disposition: Disposition
  onSet: (d: Disposition) => void
}

/**
 * Use/Ignore grouped on the left, Discard alone on the right — Discard is a
 * different kind of decision (it reverts an edit rather than choosing what to
 * do with it); `.git-field-row-actions`'s `space-between` pins the two groups apart.
 */
function DispositionButtons({ disposition, onSet }: DispositionButtonsProps) {
  const t = useT()
  return (
    <div className="git-field-row-actions" role="group">
      <div className="git-disposition-group">
        <button
          type="button"
          className={`git-disposition-btn${disposition === 'use' ? ' active' : ''}`}
          title={t('git.dialog.useTitle')}
          onClick={() => onSet('use')}
        >
          {t('git.dialog.use')}
        </button>
        <button
          type="button"
          className={`git-disposition-btn${disposition === 'ignore' ? ' active' : ''}`}
          title={t('git.dialog.ignoreTitle')}
          onClick={() => onSet('ignore')}
        >
          {t('git.dialog.ignore')}
        </button>
      </div>
      <button
        type="button"
        className={`git-disposition-btn git-disposition-discard${disposition === 'discard' ? ' active' : ''}`}
        title={t('git.dialog.discardTitle')}
        onClick={() => onSet('discard')}
      >
        {t('git.dialog.discard')}
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
  const t = useT()
  return (
    <li className={`git-field-row${disposition === 'discard' ? ' is-discard' : ''}`}>
      <div className="git-field-row-head">
        <span className="git-field-row-paper">{change.paperTitle}</span>
        <span className="git-field-row-label">{change.label}</span>
      </div>
      <div className="git-field-row-values">
        <span className="git-field-row-was" title={t('git.field.committedValue')}>
          {t('git.field.was')}: {formatValue(change.headValue)}
        </span>
        <span className="git-field-row-now" title={t('git.field.workingValue')}>
          {t('git.field.now')}: {formatValue(change.workingValue)}
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
  const t = useT()
  return (
    <li className={`git-field-row${disposition === 'discard' ? ' is-discard' : ''}`}>
      <div className="git-field-row-head">
        <span className="git-field-row-label">
          {change.kind === 'added' ? t('git.paper.added') : t('git.paper.removed')}: {change.paperTitle}
        </span>
      </div>
      <DispositionButtons disposition={disposition} onSet={onSet} />
    </li>
  )
}
