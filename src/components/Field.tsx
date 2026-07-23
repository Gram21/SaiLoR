import { useEffect, useRef, useState } from 'react'
import { deferredConsolidationKey, fieldPath, useStore, useAiMark, type PathSeg } from '../state/store'
import type { ResolvedDef } from '../model/schema'
import type { FieldValue } from '../model/annotations'
import { readyToConsolidate } from '../consolidate/readiness'
import { parseYear, YEAR_MIN, YEAR_MAX } from '../model/year'
import { ComboBox } from './ComboBox'

const MAX_TEXTAREA_HEIGHT = 240

interface FieldProps {
  def: ResolvedDef
  path: PathSeg[]
  index: number
  value: FieldValue
  /** Accessible name for the control — its `NodeName` is a separate element,
   *  not a `<label>`, so without this the control has none. */
  ariaLabel?: string
}

/** Renders the editable control for a single field instance, plus a "grab from PDF" button. */
export function Field({ def, path, index, value, ariaLabel }: FieldProps) {
  const setFieldValue = useStore((s) => s.setFieldValue)
  const set = (v: FieldValue) => setFieldValue(path, def.name, index, v)

  // Reaching the control at all — clicking it, or tabbing into it — is the
  // reviewer confirming they have seen what the AI put there, so the mark goes.
  const [marked, confirm] = useAiMark(path, def.name, index)
  const markClass = marked ? ' ai-marked' : ''
  const deferred = useStore((s) => {
    if (s.currentReviewer !== 'consolidation' || !s.currentPaperId) return false
    return !!s.deferredConsolidations[deferredConsolidationKey(s.currentPaperId, fieldPath(path, def.name, index))]
  })
  const deferredClass = deferred ? ' consolidation-pending' : ''

  // Only Consolidation gets the compare popup — everyone else has one tree to
  // work with and nothing to reconcile.
  const isConsolidation = useStore((s) => s.currentReviewer === 'consolidation')
  const openConsolidation = useStore((s) => s.openConsolidation)
  // ...and only once every reviewer has actually had their say on this paper.
  // A reviewer who has not reached it yet would show as an empty column, which
  // reads as "they found nothing" rather than "they have not looked" — the
  // compare popup would be inviting a decision on evidence that does not exist.
  // Same rule as the paper list's dot, so the two cannot disagree about which
  // papers are ready.
  const ready = useStore((s) =>
    s.project && s.currentReviewer === 'consolidation'
      ? (() => {
          const paper = s.project.papers.find((p) => p.id === s.currentPaperId)
          return !!paper && readyToConsolidate(s.project.schema, paper, s.project.reviewers)
        })()
      : false,
  )
  const compareBtn = isConsolidation && (
    <button
      type="button"
      className="compare-btn"
      disabled={!ready}
      title={
        ready
          ? "Compare every reviewer's answer for this field"
          : 'Not every reviewer has annotated this paper yet — there is nothing to compare against until they have'
      }
      onClick={() => openConsolidation(path, def.name, index)}
    >
      ⇄
    </button>
  )

  const grabFromPdf = () => {
    const sel = useStore.getState().pdfSelection.trim()
    if (!sel) return
    if (def.type === 'number') {
      const n = parseNumber(sel)
      if (n !== null) set(n)
    } else if (def.type === 'year') {
      // Not `parseNumber`: that grabs the first numeric token in the
      // selection regardless of size, so a selection like "Vol. 12, 2021"
      // would read as `12`. `parseYear` looks specifically for a plausible
      // four-digit year instead.
      const y = parseYear(sel)
      if (y !== undefined) set(y)
    } else {
      set(sel)
    }
  }

  if (def.type === 'boolean') {
    return (
      <div className="field-row">
        <input
          type="checkbox"
          className={`field-checkbox${markClass}${deferredClass}`}
          checked={value === true}
          aria-label={ariaLabel}
          onFocus={confirm}
          onClick={confirm}
          onChange={(e) => set(e.target.checked)}
        />
        {compareBtn}
      </div>
    )
  }

  // A string field with `options` is an enum → dropdown (no free-text grab).
  const isEnum = def.type === 'string' && !!def.options && def.options.length > 0
  const canGrab = def.type === 'number' || def.type === 'year' || (def.type === 'string' && !isEnum)

  return (
    <div className="field-row">
      {def.type === 'number' || def.type === 'year' ? (
        <input
          type="number"
          className={`field-input${markClass}${deferredClass}`}
          value={value === null || value === undefined ? '' : String(value)}
          aria-label={ariaLabel}
          // A bounded, whole-number control for `year` — the same reason the
          // validator gives it its own message: "a number" invites a decimal
          // or a magnitude that is not a plausible year, and this catches the
          // slip before it is ever saved rather than only reporting it later.
          {...(def.type === 'year' ? { min: YEAR_MIN, max: YEAR_MAX, step: 1 } : {})}
          onFocus={confirm}
          onClick={confirm}
          onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
        />
      ) : isEnum ? (
        <ComboBox
          value={typeof value === 'string' ? value : null}
          options={def.options!}
          onChange={(v) => set(v)}
          className={`${markClass}${deferredClass}`.trim()}
          onInteract={confirm}
          ariaLabel={ariaLabel}
        />
      ) : (
        <StringField
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(v) => set(v === '' ? null : v)}
          className={`${markClass}${deferredClass}`}
          onInteract={confirm}
          ariaLabel={ariaLabel}
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
      {compareBtn}
    </div>
  )
}

interface StringFieldProps {
  value: string
  onChange: (v: string) => void
  className?: string
  onInteract?: () => void
  ariaLabel?: string
}

/** Auto-expanding text field: single-line when idle, grows downward (capped) while focused. */
function StringField({ value, onChange, className = '', onInteract, ariaLabel }: StringFieldProps) {
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
      className={
        (expanded ? 'field-input field-textarea expanded' : 'field-input field-textarea') + className
      }
      value={value}
      aria-label={ariaLabel}
      onClick={onInteract}
      onFocus={() => {
        onInteract?.()
        setExpanded(true)
      }}
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
