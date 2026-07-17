import { useStore } from '../state/store'
import { useGitStore } from '../state/gitStore'
import { treeLabel, type FieldConflict } from '../git/merge'
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
  const resolveConflict = useGitStore((s) => s.resolveConflict)
  const takeSide = useGitStore((s) => s.takeSide)
  const takeAll = useGitStore((s) => s.takeAll)
  const finishMerge = useGitStore((s) => s.finishMerge)
  const cancelMerge = useGitStore((s) => s.cancelMerge)

  if (!merge) return null

  const decidedCount = Object.keys(merge.decided).length
  const allDecided = decidedCount >= merge.conflicts.length

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
            <button type="button" onClick={() => takeAll('ours')}>
              Use all mine
            </button>
            <button type="button" onClick={() => takeAll('theirs')}>
              Use all remote
            </button>
          </div>

          {merge.notes.length > 0 && (
            <ul className="git-notes">
              {merge.notes.map((n, i) => (
                <li key={i}>{n.message}</li>
              ))}
            </ul>
          )}

          <ul className="git-merge-rows">
            {merge.conflicts.map((c) => (
              <ConflictRow
                key={c.id}
                conflict={c}
                reviewers={reviewers}
                decided={!!merge.decided[c.id]}
                value={c.id in merge.resolutions ? merge.resolutions[c.id] : c.ours}
                onTake={(side) => takeSide(c.id, side)}
                onChange={(v) => resolveConflict(c.id, v)}
              />
            ))}
          </ul>
        </div>

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
  value: FieldValue
  onTake: (side: 'ours' | 'theirs') => void
  onChange: (value: FieldValue) => void
}

function ConflictRow({ conflict, reviewers, decided, value, onTake, onChange }: ConflictRowProps) {
  const where = [treeLabel(conflict.tree, reviewers), conflict.paperTitle].filter(Boolean).join(' · ')

  return (
    <li className={`git-merge-row${decided ? '' : ' is-undecided'}`}>
      <div className="git-merge-row-head">
        {where && <span className="git-merge-where">{where}</span>}
        <span className="git-merge-label">{conflict.label}</span>
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
  return (
    <input
      className="field-input"
      type="text"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
