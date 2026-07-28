import { useEffect, useRef, useState } from 'react'
import {
  deferredConsolidationKey,
  fieldPath,
  useStore,
  useAiMark,
  useLinkedMarkCount,
  type PathSeg,
} from '../state/store'
import type { ResolvedDef } from '../model/schema'
import type { FieldValue } from '../model/annotations'
import { readyToConsolidate } from '../consolidate/readiness'
import { parseYear, YEAR_MIN, YEAR_MAX } from '../model/year'
import { ComboBox } from './ComboBox'
import { useConsolidationFieldStatus } from './ConsolidationVerdicts'

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
  const canonical = fieldPath(path, def.name, index)
  const deferred = useStore((s) => {
    if (s.currentReviewer !== 'consolidation' || !s.currentPaperId) return false
    return !!s.deferredConsolidations[deferredConsolidationKey(s.currentPaperId, canonical)]
  })
  const deferredClass = deferred ? ' consolidation-pending' : ''
  const verdict = useConsolidationFieldStatus(canonical)
  const verdictClass = verdict ? ` consolidation-${verdict}` : ''

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

  // "Why did I pick this value" — link a PDF highlight/note as evidence.
  // Applies to every field type, not just the ones `canGrab` covers below: a
  // checkbox or dropdown choice deserves a reason just as much as free text.
  const linkCount = useLinkedMarkCount(path, def.name, index)
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)
  const linkBtn = (
    <div className="field-link-wrap">
      <button
        type="button"
        className={`link-btn${linkCount > 0 ? ' has-links' : ''}`}
        title={
          linkCount > 0
            ? `Linked to ${linkCount} PDF mark${linkCount === 1 ? '' : 's'}`
            : 'Link a PDF highlight or note as evidence'
        }
        onClick={() => setLinkPopoverOpen((v) => !v)}
      >
        <span className="link-icon">🔗</span>
        {linkCount > 0 && <span className="link-count">{linkCount}</span>}
      </button>
      {linkPopoverOpen && (
        <FieldLinkPopover
          path={path}
          name={def.name}
          index={index}
          onClose={() => setLinkPopoverOpen(false)}
        />
      )}
    </div>
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
          className={`field-checkbox${markClass}${deferredClass}${verdictClass}`}
          checked={value === true}
          aria-label={ariaLabel}
          onFocus={confirm}
          onClick={confirm}
          onChange={(e) => set(e.target.checked)}
        />
        {linkBtn}
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
          className={`field-input${markClass}${deferredClass}${verdictClass}`}
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
          className={`${markClass}${deferredClass}${verdictClass}`.trim()}
          onInteract={confirm}
          ariaLabel={ariaLabel}
        />
      ) : (
        <StringField
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(v) => set(v === '' ? null : v)}
          className={`${markClass}${deferredClass}${verdictClass}`}
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
      {linkBtn}
      {compareBtn}
    </div>
  )
}

interface FieldLinkPopoverProps {
  path: PathSeg[]
  name: string
  index: number
  onClose: () => void
}

/** Shows which of the paper's PDF marks are already linked to this field
 *  instance, plus a fold-out picker (search included) to link more. The only
 *  entry point for creating a link — the mark's own popover (`PdfViewer.tsx`)
 *  only shows/unlinks, never adds. */
function FieldLinkPopover({ path, name, index, onClose }: FieldLinkPopoverProps) {
  const marks = useStore((s) => s.currentPdfMarks())
  const linkMark = useStore((s) => s.linkMarkToField)
  const unlinkMark = useStore((s) => s.unlinkMarkFromField)
  const jumpToMark = useStore((s) => s.setPendingMarkJump)
  const canonical = fieldPath(path, name, index)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')

  // Centered in the annotation panel — not anchored to the trigger button —
  // at 95% of the panel's width, seeded once at open (not kept in sync
  // afterward, so a manual resize via the CSS `resize: horizontal` isn't
  // fought on the next render). `position: fixed` with this and a
  // `translate(-50%, -50%)` in the CSS is what makes the seeded point the
  // popover's actual center regardless of where the button that opened it
  // happens to sit.
  const [placement] = useState<{ left: number; top: number; width: number } | undefined>(() => {
    const panel = document.querySelector('.panel.annotations')
    if (!panel) return undefined
    const r = panel.getBoundingClientRect()
    return { left: r.left + r.width / 2, top: r.top + r.height / 2, width: r.width * 0.95 }
  })

  // Dismiss on Escape or an outside mousedown — same ancestry-checked pattern
  // `PdfViewer.tsx`'s popovers use, since `mousedown` fires before `click` and
  // a `stopPropagation` on click alone wouldn't beat it.
  useEffect(() => {
    const dismiss = (e?: MouseEvent) => {
      if (e && (e.target as HTMLElement | null)?.closest('.field-link-popover, .link-btn')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const linkedMarks = marks.filter((m) => m.linkedFields?.some((l) => l.path === canonical))
  const unlinkedMarks = marks.filter((m) => !m.linkedFields?.some((l) => l.path === canonical))
  const needle = search.trim().toLowerCase()
  const candidates = needle ? unlinkedMarks.filter((m) => m.comment.toLowerCase().includes(needle)) : unlinkedMarks

  // Clicking a mark's own text jumps to it in the PDF (`PdfViewer` scrolls to
  // and briefly flashes it) without linking/unlinking or closing this popover
  // — a way to see which mark is which before committing to one.
  const snippetOf = (m: (typeof marks)[number]) => (
    <button
      type="button"
      className="field-link-snippet-btn"
      title={m.comment || `Page ${m.page}`}
      onClick={() => jumpToMark(m.id)}
    >
      {m.comment || `p.${m.page}`}
    </button>
  )

  return (
    <div
      className="field-link-popover"
      style={placement}
      onClick={(e) => e.stopPropagation()}
    >
      {linkedMarks.length === 0 ? (
        <p className="field-link-empty">No links yet.</p>
      ) : (
        <ul className="field-link-list">
          {linkedMarks.map((m) => (
            <li key={m.id}>
              <span className="pdf-color-swatch" style={{ background: m.color }} aria-hidden="true" />
              {snippetOf(m)}
              <button
                type="button"
                className="field-link-unlink"
                title="Unlink"
                onClick={() => unlinkMark(m.id, canonical)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="field-link-toggle" onClick={() => setPickerOpen((v) => !v)}>
        {pickerOpen ? 'Cancel' : '+ Link a highlight or note'}
      </button>
      {pickerOpen && (
        <div className="field-link-picker">
          <ul className="field-link-list field-link-picker-list">
            {candidates.length === 0 ? (
              <li className="field-link-empty">
                {marks.length === 0 ? 'No highlights or notes on this paper yet.' : 'No matches.'}
              </li>
            ) : (
              candidates.map((m) => (
                <li key={m.id}>
                  <span className="pdf-color-swatch" style={{ background: m.color }} aria-hidden="true" />
                  {snippetOf(m)}
                  <button type="button" onClick={() => linkMark(m.id, path, name, index)}>
                    Link
                  </button>
                </li>
              ))
            )}
          </ul>
          <input
            type="text"
            className="field-link-search"
            placeholder="Search highlights/notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}
      <button type="button" className="primary" onClick={onClose}>
        Done
      </button>
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
