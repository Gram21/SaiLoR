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
import { dedupeMarkGroups, orderMarksForLinking } from '../model/pdfMarks'
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
  const linkPopoverOpen = useStore((s) => s.openLinkPopoverField === canonical)
  const setOpenLinkPopoverField = useStore((s) => s.setOpenLinkPopoverField)
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
  const linkBtnRef = useRef<HTMLButtonElement>(null)
  const linkBtn = (
    <div className="field-link-wrap">
      <button
        ref={linkBtnRef}
        type="button"
        className={`link-btn${linkCount > 0 ? ' has-links' : ''}`}
        title={
          linkCount > 0
            ? `Linked to ${linkCount} PDF mark${linkCount === 1 ? '' : 's'}`
            : 'Link a PDF highlight or note as evidence'
        }
        onClick={() => setOpenLinkPopoverField(linkPopoverOpen ? null : canonical)}
      >
        <span className="link-icon">🔗</span>
        {linkCount > 0 && <span className="link-count">{linkCount}</span>}
      </button>
      {linkPopoverOpen && (
        <FieldLinkPopover
          path={path}
          name={def.name}
          index={index}
          triggerRef={linkBtnRef}
          onClose={() => setOpenLinkPopoverField(null)}
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
  /** The button that opened this popover — its bottom edge (plus a 1px gap)
   *  is where the popover's top sits; see `placement` below. */
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}

/** One list of every PDF mark on the paper, each showing Link/× for whether
 *  it names this field instance as evidence. The only entry point for
 *  creating a link — the mark's own popover (`PdfViewer.tsx`) only
 *  shows/unlinks, never adds. */
function FieldLinkPopover({ path, name, index, triggerRef, onClose }: FieldLinkPopoverProps) {
  const marks = dedupeMarkGroups(useStore((s) => s.currentPdfMarks()))
  const linkMark = useStore((s) => s.linkMarkToField)
  const unlinkMark = useStore((s) => s.unlinkMarkFromField)
  const jumpToMark = useStore((s) => s.setPendingMarkJump)
  const lastCreatedMarkId = useStore((s) => s.lastCreatedMarkId)
  const setLastCreatedMarkId = useStore((s) => s.setLastCreatedMarkId)
  const canonical = fieldPath(path, name, index)

  const [search, setSearch] = useState('')

  // Auto-link the highlight/note the reviewer just made, once — see
  // `lastCreatedMarkId`'s own doc comment. Finishing a mark and immediately
  // opening a field to link it is the whole point of having just made it,
  // so there is nothing to search for or click on the first time through.
  // `linkMarkToField` already no-ops on an unknown id or an existing link,
  // so nothing here needs to check either case first.
  useEffect(() => {
    if (lastCreatedMarkId) linkMark(lastCreatedMarkId, path, name, index)
    setLastCreatedMarkId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Horizontally centered on the annotation panel — not the trigger button —
  // at 95% of the panel's width; vertically, directly under the button that
  // opened it (its bottom edge + 1px). Both seeded once at open, not kept in
  // sync afterward, so a manual resize via the CSS `resize: horizontal`
  // isn't fought on the next render. `position: fixed` plus a
  // `translateX(-50%)` in the CSS is what turns the seeded `left` into the
  // popover's horizontal center rather than its corner.
  //
  // Because it is `fixed`, anything hanging below the viewport is simply
  // unreachable — the page behind it scrolls, the popover doesn't. So for a
  // field near the bottom of the window we flip it above the button, and
  // either way cap its height to the room actually available; the popover's
  // own `overflow: auto` then makes the overflow scrollable.
  const [placement] = useState<React.CSSProperties | undefined>(() => {
    const panel = document.querySelector('.panel.annotations')
    const button = triggerRef.current
    if (!panel || !button) return undefined
    const panelRect = panel.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    const left = panelRect.left + panelRect.width / 2
    const width = panelRect.width * 0.95

    const MARGIN = 8 // breathing room against the viewport edge
    const MIN_BELOW = 180 // below this, flipping above is worth it
    const below = window.innerHeight - buttonRect.bottom - 1 - MARGIN
    const above = buttonRect.top - 1 - MARGIN
    if (below < MIN_BELOW && above > below) {
      return { left, width, bottom: window.innerHeight - buttonRect.top + 1, maxHeight: above }
    }
    return { left, width, top: buttonRect.bottom + 1, maxHeight: below }
  })

  // Dismiss on Escape or an outside mousedown — same ancestry-checked pattern
  // `PdfViewer.tsx`'s popovers use, since `mousedown` fires before `click` and
  // a `stopPropagation` on click alone wouldn't beat it.
  useEffect(() => {
    const dismiss = (e?: MouseEvent) => {
      // `.link-btn` here is what stops a field's own trigger from reopening
      // the popover it just closed: mousedown closes it, React flushes
      // before the `click` fires, and the render-captured `linkPopoverOpen`
      // used by that `onClick` handler is then already false. A sibling
      // field's popover opening and this one closing is now handled by the
      // shared `openLinkPopoverField` id making this Field's selector go
      // false and unmount — not by this dismisser.
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

  // Recently-added first (a reviewer who just made a mark is almost always
  // about to link it), then everything else in page order — see
  // `orderMarksForLinking`. Fixed regardless of link state, so linking or
  // unlinking a mark never moves it: only its own Link/× button changes.
  const ordered = orderMarksForLinking(marks)
  const recentIds = new Set(ordered.slice(0, 3).map((m) => m.id))
  const needle = search.trim().toLowerCase()
  const filtered = needle
    ? ordered.filter((m) => (m.comment || m.text || '').toLowerCase().includes(needle))
    : ordered

  // The row where the "recently added" group gives way to the page-ordered
  // rest, so a small gap can mark the seam — only meaningful when both groups
  // actually survive the search filter.
  const gapBeforeIndex = filtered.findIndex(
    (m, i) => i > 0 && recentIds.has(filtered[i - 1].id) && !recentIds.has(m.id),
  )

  // Clicking a mark's own text jumps to it in the PDF (`PdfViewer` scrolls to
  // and briefly flashes it) without linking/unlinking or closing this popover
  // — a way to see which mark is which before committing to one.
  const snippetOf = (m: (typeof marks)[number]) => (
    <button
      type="button"
      className="field-link-snippet-btn"
      title={m.comment || m.text || `Page ${m.page}`}
      onClick={() => jumpToMark(m.id)}
    >
      {m.comment || m.text || `p.${m.page}`}
    </button>
  )

  return (
    <div className="field-link-popover" style={placement} onClick={(e) => e.stopPropagation()}>
      {marks.length === 0 ? (
        <p className="field-link-empty">No highlights or notes on this paper yet.</p>
      ) : (
        <>
          <input
            type="text"
            className="field-link-search"
            placeholder="Search highlights/notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {filtered.length === 0 ? (
            <p className="field-link-empty">No matches.</p>
          ) : (
            <ul className="field-link-list">
              {filtered.map((m, i) => {
                const linked = m.linkedFields?.some((l) => l.path === canonical) ?? false
                return (
                  <li key={m.id} className={i === gapBeforeIndex ? 'field-link-gap' : undefined}>
                    <span className="pdf-color-swatch" style={{ background: m.color }} aria-hidden="true" />
                    {snippetOf(m)}
                    {linked ? (
                      <button
                        type="button"
                        className="field-link-unlink"
                        title="Unlink"
                        onClick={() => unlinkMark(m.id, canonical)}
                      >
                        ×
                      </button>
                    ) : (
                      <button type="button" onClick={() => linkMark(m.id, path, name, index)}>
                        Link
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </>
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
