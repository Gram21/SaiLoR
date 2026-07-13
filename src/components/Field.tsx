import { useEffect, useRef, useState } from 'react'
import { useStore, type PathSeg } from '../state/store'
import type { ResolvedDef } from '../model/schema'
import type { FieldValue } from '../model/annotations'

const MAX_TEXTAREA_HEIGHT = 240

interface FieldProps {
  def: ResolvedDef
  path: PathSeg[]
  index: number
  value: FieldValue
}

/** Renders the editable control for a single field instance, plus a "grab from PDF" button. */
export function Field({ def, path, index, value }: FieldProps) {
  const setFieldValue = useStore((s) => s.setFieldValue)
  const set = (v: FieldValue) => setFieldValue(path, def.name, index, v)

  const grabFromPdf = () => {
    const sel = useStore.getState().pdfSelection.trim()
    if (!sel) return
    if (def.type === 'number') {
      const n = parseNumber(sel)
      if (n !== null) set(n)
    } else {
      set(sel)
    }
  }

  if (def.type === 'boolean') {
    return (
      <input
        type="checkbox"
        className="field-checkbox"
        checked={value === true}
        onChange={(e) => set(e.target.checked)}
      />
    )
  }

  const canGrab = def.type === 'string' || def.type === 'number'

  return (
    <div className="field-row">
      {def.type === 'number' ? (
        <input
          type="number"
          className="field-input"
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
        />
      ) : (
        <StringField
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(v) => set(v === '' ? null : v)}
        />
      )}
      {canGrab && (
        <button
          type="button"
          className="grab-btn"
          title="Insert the text currently selected in the PDF"
          onClick={grabFromPdf}
        >
          ⧉
        </button>
      )}
    </div>
  )
}

interface StringFieldProps {
  value: string
  onChange: (v: string) => void
}

/** Auto-expanding text field: single-line when idle, grows downward (capped) while focused. */
function StringField({ value, onChange }: StringFieldProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [expanded, setExpanded] = useState(false)

  // Grow to fit content (capped) while focused; stay collapsed otherwise.
  const resize = () => {
    const el = ref.current
    if (!el) return
    if (!expanded) {
      el.style.height = ''
      return
    }
    // Reset first so scrollHeight reflects the content, not the current box.
    el.style.height = ''
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }

  // Recompute when focus state or the external value changes.
  useEffect(resize, [expanded, value])

  return (
    <textarea
      ref={ref}
      rows={1}
      maxLength={500}
      className={expanded ? 'field-input field-textarea expanded' : 'field-input field-textarea'}
      value={value}
      onFocus={() => setExpanded(true)}
      onBlur={() => {
        setExpanded(false)
        if (ref.current) ref.current.style.height = ''
      }}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function parseNumber(s: string): number | null {
  // Grab the first numeric token from the selection (tolerates surrounding text).
  const match = s.replace(',', '.').match(/-?\d+(\.\d+)?/)
  if (!match) return null
  const n = Number(match[0])
  return Number.isFinite(n) ? n : null
}
