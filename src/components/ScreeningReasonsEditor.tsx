// [impl->req~scr-250~1]
import { useRef } from 'react'
import { useEditorStore } from '../state/editorStore'
import { countPapersUsingReason } from '../screening/reasonUsage'
import { tp, rich, useT } from '../i18n'

/**
 * The one authorable part of a screening project's schema: the exclusion
 * reasons, fixed up front the way a pre-registered SLR protocol fixes them.
 * Replaces `SchemaTreeEditor` in `ProjectEditor.tsx` whenever screening is on
 * — there is no schema to build, only this short, ordered list.
 */
export function ScreeningReasonsEditor() {
  const t = useT()
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
    // [impl->req~scr-260~1]
    const next = [...reasons]
    next[i] = value
    setScreeningReasons(next)
  }

  // [impl->req~scr-260~1]
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
    if (to.trim() === '') {
      window.alert(tp('editor.screeningReasons.removedAlert', count, { from }))
      return
    }
    const migrate = window.confirm(tp('editor.screeningReasons.renameConfirm', count, { from, to }))
    if (migrate) migrateScreeningReason(from, to)
  }
  // [impl->req~scr-270~1]
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
      // [impl->req~scr-270~1]
      const ok = window.confirm(tp('editor.screeningReasons.removeConfirm', count, { label }))
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
      <p className="editor-hint">{rich('editor.screeningReasons.hint')}</p>
      <ul className="screening-reasons-list">
        {reasons.map((reason, i) => (
          <li key={i} className="screening-reasons-row">
            <span className="screening-reasons-index">{i < 9 ? i + 1 : ''}</span>
            <input
              type="text"
              className="screening-reasons-input"
              value={reason}
              placeholder={t('editor.screeningReasons.placeholder')}
              onFocus={() => {
                editingFrom.current[i] = reason
              }}
              onChange={(e) => patch(i, e.target.value)}
              onBlur={() => commitRename(i)}
            />
            <button
              type="button"
              className="icon-btn"
              title={t('editor.screeningReasons.moveUpTitle')}
              aria-label={t('editor.screeningReasons.moveUp', { name: reason || t('editor.screeningReasons.thisReason') })}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="icon-btn"
              title={t('editor.screeningReasons.moveDownTitle')}
              aria-label={t('editor.screeningReasons.moveDown', { name: reason || t('editor.screeningReasons.thisReason') })}
              disabled={i === reasons.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="remove-btn"
              title={t('editor.screeningReasons.removeTitle')}
              aria-label={t('editor.screeningReasons.remove', { name: reason || t('editor.screeningReasons.thisReason') })}
              onClick={() => remove(i)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={add} title={t('editor.screeningReasons.addTitle')}>
        {t('editor.screeningReasons.add')}
      </button>
    </div>
  )
}
