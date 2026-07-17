import { useRef } from 'react'
import { useEditorStore } from '../state/editorStore'
import { countPapersUsingReason } from '../screening/reasonUsage'

/**
 * The one authorable part of a screening project's schema: the exclusion
 * reasons, fixed up front the way a pre-registered SLR protocol fixes them.
 * Replaces `SchemaTreeEditor` in `ProjectEditor.tsx` whenever screening is on
 * — there is no schema to build, only this short, ordered list.
 */
export function ScreeningReasonsEditor() {
  const screening = useEditorStore((s) => s.screening)
  const papers = useEditorStore((s) => s.papers)
  const setScreeningReasons = useEditorStore((s) => s.setScreeningReasons)
  const migrateScreeningReason = useEditorStore((s) => s.migrateScreeningReason)

  // The reason's text when a field gained focus, per index — so a *committed*
  // rename (on blur) can be compared against what papers actually reference,
  // rather than firing a confirm on every keystroke of the edit.
  const editingFrom = useRef<Record<number, string>>({})

  if (!screening) return null
  const reasons = screening.reasons

  const patch = (i: number, value: string) => {
    const next = [...reasons]
    next[i] = value
    setScreeningReasons(next)
  }

  /**
   * On blur: if this row was renamed away from a reason papers still record,
   * offer to carry those decisions over to the new label. Declining leaves
   * them pointing at a reason no longer in the list — orphaned, but the
   * reviewer was told, instead of it happening silently (caught only later by
   * Validate). An empty new label has nothing to migrate *to*, so it only
   * warns; nothing is rewritten.
   */
  const commitRename = (i: number) => {
    const from = editingFrom.current[i]
    delete editingFrom.current[i]
    const to = reasons[i]
    if (from === undefined || from === to) return
    const count = countPapersUsingReason(papers, from)
    if (count === 0) return
    const many = count === 1 ? '1 paper' : `${count} papers`
    if (to.trim() === '') {
      window.alert(
        `${many} still record "${from}" as their exclusion reason, which you have now removed from ` +
          `the list — those decisions no longer point at a listed reason. Give the reason a name, or ` +
          `re-screen those papers.`,
      )
      return
    }
    const migrate = window.confirm(
      `${many} record "${from}" as their exclusion reason. Rename it to "${to}" for those papers too?\n\n` +
        `OK: update ${count === 1 ? 'that decision' : 'those decisions'} to "${to}".\n` +
        `Cancel: leave them pointing at "${from}", which is no longer in the list.`,
    )
    if (migrate) migrateScreeningReason(from, to)
  }
  /**
   * Removing a reason papers still record orphans those decisions just as an
   * empty rename does — so it warns the same way rather than dropping them
   * silently (the asymmetry that let a `×` click do what `commitRename` was
   * built to prevent). There is no new label to migrate *to* on a delete, so
   * the only choice offered is remove-anyway vs keep.
   */
  const remove = (i: number) => {
    const label = reasons[i]
    const count = label.trim() === '' ? 0 : countPapersUsingReason(papers, label)
    if (count > 0) {
      const many = count === 1 ? '1 paper' : `${count} papers`
      const ok = window.confirm(
        `${many} record "${label}" as their exclusion reason. Remove it anyway?\n\n` +
          `Those ${count === 1 ? 'decision' : 'decisions'} will no longer point at a listed reason ` +
          `(Validate will flag them); the papers keep their excluded state but lose the reason.`,
      )
      if (!ok) return
    }
    setScreeningReasons(reasons.filter((_, j) => j !== i))
  }
  const add = () => {
    setScreeningReasons([...reasons, ''])
  }
  const move = (i: number, dir: -1 | 1) => {
    const at = i + dir
    if (at < 0 || at >= reasons.length) return
    const next = [...reasons]
    ;[next[i], next[at]] = [next[at], next[i]]
    setScreeningReasons(next)
  }

  return (
    <div className="screening-reasons">
      <p className="editor-hint">
        The reviewer's <kbd>1</kbd>-<kbd>9</kbd> keys exclude with the corresponding reason in one
        press, in this order — put the common reasons near the top.
      </p>
      <ul className="screening-reasons-list">
        {reasons.map((reason, i) => (
          <li key={i} className="screening-reasons-row">
            <span className="screening-reasons-index">{i < 9 ? i + 1 : ''}</span>
            <input
              type="text"
              className="screening-reasons-input"
              value={reason}
              placeholder="Reason"
              onFocus={() => {
                editingFrom.current[i] = reason
              }}
              onChange={(e) => patch(i, e.target.value)}
              onBlur={() => commitRename(i)}
            />
            <button
              type="button"
              className="icon-btn"
              title="Move up"
              aria-label={`Move "${reason || 'this reason'}" up`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Move down"
              aria-label={`Move "${reason || 'this reason'}" down`}
              disabled={i === reasons.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="remove-btn"
              title="Remove this reason"
              aria-label={`Remove "${reason || 'this reason'}"`}
              onClick={() => remove(i)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={add}>
        + Add reason
      </button>
    </div>
  )
}
