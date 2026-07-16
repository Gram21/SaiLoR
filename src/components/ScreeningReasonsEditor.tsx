import { useEditorStore } from '../state/editorStore'

/**
 * The one authorable part of a screening project's schema: the exclusion
 * reasons, fixed up front the way a pre-registered SLR protocol fixes them.
 * Replaces `SchemaTreeEditor` in `ProjectEditor.tsx` whenever screening is on
 * — there is no schema to build, only this short, ordered list.
 */
export function ScreeningReasonsEditor() {
  const screening = useEditorStore((s) => s.screening)
  const setScreeningReasons = useEditorStore((s) => s.setScreeningReasons)

  if (!screening) return null
  const reasons = screening.reasons

  const patch = (i: number, value: string) => {
    const next = [...reasons]
    next[i] = value
    setScreeningReasons(next)
  }
  const remove = (i: number) => {
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
              onChange={(e) => patch(i, e.target.value)}
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
