import { useStore, type PathSeg } from '../state/store'
import type { ResolvedDef } from '../model/schema'
import type { FieldValue } from '../model/annotations'

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
        <input
          type="text"
          className="field-input"
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => set(e.target.value === '' ? null : e.target.value)}
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

function parseNumber(s: string): number | null {
  // Grab the first numeric token from the selection (tolerates surrounding text).
  const match = s.replace(',', '.').match(/-?\d+(\.\d+)?/)
  if (!match) return null
  const n = Number(match[0])
  return Number.isFinite(n) ? n : null
}
