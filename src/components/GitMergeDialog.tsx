import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { useGitStore } from '../state/gitStore'
import { treeLabel, type FieldConflict, type MergeTree } from '../git/merge'
import type { FieldValue } from '../model/annotations'
import { YEAR_MIN, YEAR_MAX } from '../model/year'
import { ComboBox } from './ComboBox'
import '../styles/git.css'

/**
 * The conflict resolution list — the UI half of the pull's three-way merge.
 * Everything a field-level merge could settle on its own is already merged by
 * the time this opens; every row here is a field **both** sides changed, to
 * different things, which is the one case nothing but a person can settle.
 *
 * Deliberately has no Escape, no backdrop-click, and no × in the header: the
 * repository is mid-merge for as long as this is open, and dismissing it
 * without finishing or explicitly cancelling would leave the reviewer's
 * checkout in a state they cannot get out of without the command line — the
 * one outcome a merge UI must never produce. Only the two buttons at the
 * bottom leave.
 */
export function GitMergeDialog() {
  const merge = useGitStore((s) => s.panel?.merge ?? null)
  const reviewers = useStore((s) => s.project?.reviewers ?? 1)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const resolveConflict = useGitStore((s) => s.resolveConflict)
  const takeSide = useGitStore((s) => s.takeSide)
  const takeAll = useGitStore((s) => s.takeAll)
  const finishMerge = useGitStore((s) => s.finishMerge)
  const cancelMerge = useGitStore((s) => s.cancelMerge)
  const error = useGitStore((s) => s.panel?.error ?? null)
  const dismissPanelMessage = useGitStore((s) => s.dismissPanelMessage)

  // One conflict list per paper (paperId '' is the project's own fields,
  // which belong to no paper), in the order `mergeProjects` produced them —
  // so a reviewer works through one paper at a time instead of a flat list
  // that interleaves papers. Recomputed only when the conflict set itself
  // changes (a new merge), never on every resolution: `merge.conflicts` keeps
  // its identity across `set()` calls that only touch `resolutions`/`decided`.
  const conflicts = merge?.conflicts ?? []
  const groups = useMemo(() => {
    const byPaper = new Map<string, { paperId: string; paperTitle: string; conflicts: FieldConflict[] }>()
    for (const c of conflicts) {
      let g = byPaper.get(c.paperId)
      if (!g) {
        g = { paperId: c.paperId, paperTitle: c.paperTitle, conflicts: [] }
        byPaper.set(c.paperId, g)
      }
      g.conflicts.push(c)
    }
    return [...byPaper.values()]
  }, [conflicts])

  // Manual open/closed state, keyed by paperId — starts empty (every group
  // expanded) and is otherwise entirely the reviewer's own doing, including
  // reopening a group the effect below just auto-closed.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const toggleGroup = (paperId: string) =>
    setCollapsed((prev) => ({ ...prev, [paperId]: !prev[paperId] }))

  // Auto-collapse a group the *moment* its last conflict gets decided — not
  // on every render while it stays fully decided, or reopening it to fix a
  // choice would just snap shut again. `wasFullyDecided` remembers which
  // groups had already fired this once, so only the actual completion edge
  // (not-decided → decided) ever forces `collapsed` closed; anything after
  // that is the reviewer's own click.
  const wasFullyDecided = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!merge) return
    const nowFullyDecided = new Set(
      groups.filter((g) => g.conflicts.every((c) => merge.decided[c.id])).map((g) => g.paperId),
    )
    const justCompleted = [...nowFullyDecided].filter((id) => !wasFullyDecided.current.has(id))
    wasFullyDecided.current = nowFullyDecided
    if (justCompleted.length > 0) {
      setCollapsed((prev) => {
        const next = { ...prev }
        for (const id of justCompleted) next[id] = true
        return next
      })
    }
  })

  if (!merge) return null

  const decidedCount = Object.keys(merge.decided).length
  const allDecided = decidedCount >= merge.conflicts.length

  // A conflict in another reviewer's own tree isn't "mine" in any sense the
  // bulk buttons below can honestly speak for — see `isForeignReview`.
  const foreignIds = new Set(
    merge.conflicts.filter((c) => isForeignReview(c.tree, currentReviewer)).map((c) => c.id),
  )
  const bulkEligibleIds = merge.conflicts.filter((c) => !foreignIds.has(c.id)).map((c) => c.id)

  return (
    <div className="modal-overlay">
      <div
        className="modal git-merge-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Resolve merge conflicts"
      >
        <div className="modal-head">
          <strong>
            Resolve merge conflicts <span className="git-merge-progress">{decidedCount} of {merge.conflicts.length} decided</span>
          </strong>
        </div>

        <div className="modal-body">
          <p>
            Your changes and {merge.ref}&apos;s both changed these fields. Everything else has already
            been merged: a field only one side changed kept that side&apos;s value.
          </p>

          <div className="git-merge-bulk">
            <button type="button" onClick={() => takeAll('ours', bulkEligibleIds)}>
              Use all mine
            </button>
            <button type="button" onClick={() => takeAll('theirs', bulkEligibleIds)}>
              Use all remote
            </button>
          </div>
          {foreignIds.size > 0 && (
            <p className="git-merge-foreign-note">
              {foreignIds.size} field{foreignIds.size === 1 ? '' : 's'} above belong to another
              reviewer&apos;s own answers, marked <span className="git-merge-foreign-badge">another reviewer</span> —
              the buttons above skip them. Decide those individually below.
            </p>
          )}

          {merge.notes.length > 0 && (
            <ul className="git-notes">
              {merge.notes.map((n, i) => (
                <li key={i}>{n.message}</li>
              ))}
            </ul>
          )}

          <ul className="git-merge-rows">
            {groups.map((g) => {
              const groupDecided = g.conflicts.filter((c) => merge.decided[c.id]).length
              const groupDone = groupDecided >= g.conflicts.length
              const isCollapsed = !!collapsed[g.paperId]
              return (
                <li key={g.paperId || '__project__'} className="git-merge-group">
                  <button
                    type="button"
                    className="git-merge-group-head"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleGroup(g.paperId)}
                  >
                    <span className={`git-merge-group-chevron${isCollapsed ? ' is-collapsed' : ''}`} aria-hidden="true">
                      ▾
                    </span>
                    <span className="git-merge-group-title">{g.paperTitle || 'Project'}</span>
                    <span className={`git-merge-group-progress${groupDone ? ' is-done' : ''}`}>
                      {groupDone ? '✓ Resolved' : `${groupDecided} of ${g.conflicts.length} decided`}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <ul className="git-merge-group-rows">
                      {g.conflicts.map((c) => (
                        <ConflictRow
                          key={c.id}
                          conflict={c}
                          reviewers={reviewers}
                          decided={!!merge.decided[c.id]}
                          foreign={foreignIds.has(c.id)}
                          value={c.id in merge.resolutions ? merge.resolutions[c.id] : c.ours}
                          onTake={(side) => takeSide(c.id, side)}
                          onChange={(v) => resolveConflict(c.id, v)}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        </div>

        {/* The Git panel renders `panel.error`, but it returns null while a
            merge is open — so without this a failure raised *by* the merge
            (most often the finishing commit being rejected: no `user.email`
            configured, or a commit hook) would leave the reviewer staring at
            an unexplained dialog whose Finish button silently re-fails. */}
        {error && (
          <div className="git-message git-message-error">
            <pre className="git-message-text">{error}</pre>
            <button
              type="button"
              className="icon-btn"
              onClick={dismissPanelMessage}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        <div className="git-merge-footer">
          <button type="button" onClick={() => void cancelMerge()}>
            Cancel merge
          </button>
          <button type="button" className="primary" disabled={!allDecided} onClick={() => void finishMerge()}>
            Finish merge
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Whether a conflict lives in a *different* reviewer's own tree than the
 * seat merging right now — the case "Use all mine"/"Use all remote" must not
 * speak for, since neither side of that conflict is the current reviewer's
 * own opinion. `currentReviewer === null` (nobody has picked a seat yet, or a
 * single-reviewer project with no `{kind:'review'}` conflicts at all) treats
 * every review-tree conflict as foreign — there is no seat it could belong to.
 */
export function isForeignReview(tree: MergeTree, currentReviewer: string | null): boolean {
  return tree.kind === 'review' && tree.reviewer !== currentReviewer
}

/** Type-aware, matching `ConsolidationDialog.tsx`'s local `formatValue` wording
 *  (not exported from there — this module writes its own so it stays free to
 *  diverge if the two dialogs' needs ever do, without one file quietly
 *  depending on the other's private helper). */
function formatValue(type: FieldConflict['type'], value: FieldValue): string {
  if (value === undefined || value === null) return '— empty —'
  if (type === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' && value.trim() === '') return '— empty —'
  return String(value)
}

interface ConflictRowProps {
  conflict: FieldConflict
  reviewers: number
  decided: boolean
  /** True when this is another reviewer's own tree — see `isForeignReview`. */
  foreign: boolean
  value: FieldValue
  onTake: (side: 'ours' | 'theirs') => void
  onChange: (value: FieldValue) => void
}

function ConflictRow({ conflict, reviewers, decided, foreign, value, onTake, onChange }: ConflictRowProps) {
  // The paper is the group header now (see the grouped list above) — this is
  // just which tree within it: "Reviewer 2", "Consolidation", "Paper
  // details", or nothing for a single-reviewer annotation conflict.
  const where = treeLabel(conflict.tree, reviewers)

  return (
    <li className={`git-merge-row${decided ? '' : ' is-undecided'}`}>
      <div className="git-merge-row-head">
        {where && <span className="git-merge-where">{where}</span>}
        <span className="git-merge-label">{conflict.label}</span>
        {foreign && (
          <span
            className="git-merge-foreign-badge"
            title="Belongs to another reviewer's own answers — the bulk buttons above skip it; use ◀/▶ to decide it here."
          >
            another reviewer
          </span>
        )}
        {!decided && <span className="git-merge-undecided-badge">not decided yet</span>}
      </div>
      <div className="git-merge-row-body">
        <div className="git-merge-side" title="Your value">
          {formatValue(conflict.type, conflict.ours)}
        </div>
        <button
          type="button"
          className="git-merge-take"
          title="Use your value"
          onClick={() => onTake('ours')}
        >
          ◀
        </button>
        <div className="git-merge-final">
          <MiddleControl conflict={conflict} value={value} onChange={onChange} />
        </div>
        <button
          type="button"
          className="git-merge-take"
          title="Use the remote value"
          onClick={() => onTake('theirs')}
        >
          ▶
        </button>
        <div className="git-merge-side" title="The remote value">
          {formatValue(conflict.type, conflict.theirs)}
        </div>
      </div>
    </li>
  )
}

function MiddleControl({
  conflict,
  value,
  onChange,
}: {
  conflict: FieldConflict
  value: FieldValue
  onChange: (value: FieldValue) => void
}) {
  if (conflict.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  }
  if (conflict.type === 'number' || conflict.type === 'year') {
    return (
      <input
        className="field-input"
        type="number"
        value={typeof value === 'number' ? value : ''}
        // A bounded control for `year`: without this a resolved conflict
        // could write a free-text string into a year field (the `type ===
        // 'number'` branch above was the only numeric one before this type
        // existed, so a `'year'` conflict would otherwise fall through to
        // the plain-text branch at the bottom of this function).
        {...(conflict.type === 'year' ? { min: YEAR_MIN, max: YEAR_MAX, step: 1 } : {})}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    )
  }
  // A free-text middle on an enum could write a value validateProject would
  // then flag — the same reason the ordinary annotation form uses ComboBox
  // for an enum field rather than a plain text input.
  if (conflict.options && conflict.options.length > 0) {
    return (
      <ComboBox
        value={typeof value === 'string' ? value : null}
        options={conflict.options}
        onChange={(v) => onChange(v)}
      />
    )
  }
  return <AutoGrowText value={typeof value === 'string' ? value : ''} onChange={onChange} />
}

/** The same auto-growing textarea `.field-textarea` is elsewhere (`Field.tsx`'s
 *  `StringField`, `GitDialog.tsx`'s commit message) — but permanently
 *  expanded, not focus-gated. Those collapse when idle because they sit among
 *  a lot of other compact controls; this one sits between two read-only
 *  values that are *also* always fully shown (`.git-merge-side` — no more
 *  clipped-to-one-line text), so collapsing the one column a reviewer can
 *  actually edit back to a single line the moment they click away would
 *  contradict the two columns either side of it. */
const MAX_FINAL_HEIGHT = 240

function AutoGrowText({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = ''
    el.style.height = `${Math.min(el.scrollHeight, MAX_FINAL_HEIGHT)}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      className="field-input field-textarea expanded"
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
