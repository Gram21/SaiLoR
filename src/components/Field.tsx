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

  // Only Consolidation gets the compare popup — everyone else has one tree to reconcile.
  const isConsolidation = useStore((s) => s.currentReviewer === 'consolidation')
  const openConsolidation = useStore((s) => s.openConsolidation)
  // ...and only once every reviewer has had their say — an unreached reviewer would
  // show as "found nothing" instead of "hasn't looked". Same rule as the paper list's dot.
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

  // "Why did I pick this value" — link a PDF highlight/note as evidence. Applies to
  // every field type, not just `canGrab` ones: a checkbox deserves a reason too.
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
      // Not `parseNumber`: "Vol. 12, 2021" would read as `12`. `parseYear` looks
      // specifically for a plausible four-digit year instead.
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
          // Bounded, whole-number control for `year` — catches an implausible value
          // or decimal before it's saved, rather than only reporting it later.
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

/** Shows marks already linked to this field, plus a fold-out picker to link more.
 *  The only entry point for creating a link — `PdfViewer.tsx`'s popover only shows/unlinks. */
function FieldLinkPopover({ path, name, index, triggerRef, onClose }: FieldLinkPopoverProps) {
  const marks = dedupeMarkGroups(useStore((s) => s.currentPdfMarks()))
  const linkMark = useStore((s) => s.linkMarkToField)
  const unlinkMark = useStore((s) => s.unlinkMarkFromField)
  const jumpToMark = useStore((s) => s.setPendingMarkJump)
  const lastCreatedMarkId = useStore((s) => s.lastCreatedMarkId)
  const lastCreatedMarkAllowedField = useStore((s) => s.lastCreatedMarkAllowedField)
  const setLastCreatedMarkId = useStore((s) => s.setLastCreatedMarkId)
  // Rebuilt each render from the store's array — cheap at these sizes, avoids
  // a second piece of state to keep in sync.
  const sessionCreatedMarkIds = new Set(useStore((s) => s.sessionCreatedMarkIds))
  const canonical = fieldPath(path, name, index)
  const isLinkedNow = (m: (typeof marks)[number]) => m.linkedFields?.some((l) => l.path === canonical) ?? false

  // Whether the mark the reviewer just made (if any) belongs to *this* field's
  // popover — see `lastCreatedMarkAllowedField`. Read once at first render, before
  // the effect below acts on it, so it also seeds this popover's `pickerOpen` below.
  const [willAutoLink] = useState(
    () => !!lastCreatedMarkId && (lastCreatedMarkAllowedField === null || lastCreatedMarkAllowedField === canonical),
  )

  // Marks already linked before this popover opened. The top list only shows these,
  // so a mark linked this session stays in the picker (button flipped to "×") until
  // reopened. Computed once, before the auto-link effect runs, so it's excluded too.
  const [initiallyLinkedIds] = useState(() => new Set(marks.filter(isLinkedNow).map((m) => m.id)))

  const [pickerOpen, setPickerOpen] = useState(willAutoLink)
  const [search, setSearch] = useState('')

  // Auto-link the mark the reviewer just made, once — see `lastCreatedMarkId`.
  // `linkMarkToField` already no-ops on an unknown id or existing link.
  useEffect(() => {
    if (willAutoLink) linkMark(lastCreatedMarkId!, path, name, index)
    setLastCreatedMarkId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Centered on the annotation panel (not the trigger button), under the button that
  // opened it. Seeded once at open so a manual CSS resize isn't fought on rerender.
  // Flips above the button when there isn't room below; height capped either way,
  // with overflow scrollable via the popover's own `overflow: auto`.
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

  // Dismiss on Escape or an outside mousedown — `mousedown` fires before `click`,
  // so a `stopPropagation` on click alone wouldn't beat it (same pattern as PdfViewer.tsx).
  useEffect(() => {
    const dismiss = (e?: MouseEvent) => {
      // `.link-btn` stops the trigger from reopening the popover it just closed via
      // this same mousedown, before its own `onClick` can fire.
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

  // Only marks both initially-linked and still linked now — unlinking still drops
  // immediately; only newly-linked marks are held back by `initiallyLinkedIds`.
  const topList = marks.filter((m) => initiallyLinkedIds.has(m.id) && isLinkedNow(m))
  // Header count reflects the live state, unlike `topList` which hides links made this session.
  const linkedCount = marks.filter(isLinkedNow).length
  // Everything not initially linked, recently-added first then page order (see
  // `orderMarksForLinking`) — fixed regardless of link state, so linking/unlinking
  // during this session never reshuffles the picker.
  const candidates = orderMarksForLinking(
    marks.filter((m) => !initiallyLinkedIds.has(m.id)),
    sessionCreatedMarkIds,
  )
  // Not just "the first 3 of `candidates`": with fewer than 3 session marks that would
  // misclassify page-ordered marks as pinned too. Filtering to session marks first
  // recovers exactly the pinned set regardless of how many `orderMarksForLinking` pinned.
  const recentIds = new Set(
    candidates.filter((m) => sessionCreatedMarkIds.has(m.id)).slice(0, 3).map((m) => m.id),
  )
  const needle = search.trim().toLowerCase()
  const filteredCandidates = needle
    ? candidates.filter((m) => (m.comment || m.text || '').toLowerCase().includes(needle))
    : candidates

  // Where "recently added" gives way to page-ordered rest, for a visual seam —
  // only meaningful when both groups survive the search filter.
  const gapBeforeIndex = filteredCandidates.findIndex(
    (m, i) => i > 0 && recentIds.has(filteredCandidates[i - 1].id) && !recentIds.has(m.id),
  )

  // Clicking a mark's text jumps to it in the PDF without linking/unlinking or
  // closing the popover — a way to see which mark is which before committing.
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
      <div className="modal-head field-link-head">
        <strong>{linkedCount === 1 ? '1 link' : `${linkedCount} links`}</strong>
        <button type="button" className="icon-btn" title="Close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="field-link-body">
        {topList.length === 0 ? (
          <p className="field-link-empty">No links yet.</p>
        ) : (
          <ul className="field-link-list">
            {topList.map((m) => (
              <li key={m.id}>
                <span className="pdf-color-swatch" style={{ background: m.color }} aria-hidden="true" />
                {snippetOf(m)}
                <button
                  type="button"
                  className="field-link-action field-link-unlink"
                  title="Unlink"
                  onClick={() => unlinkMark(m.id, canonical)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="field-link-toggle"
          title={pickerOpen ? 'Cancel linking a highlight or note' : 'Link a highlight or note as evidence'}
          onClick={() => setPickerOpen((v) => !v)}
        >
          {pickerOpen ? 'Cancel' : '+ Link a highlight or note'}
        </button>
        {pickerOpen && (
          <div className="field-link-picker">
            <ul className="field-link-list field-link-picker-list">
              {filteredCandidates.length === 0 ? (
                <li className="field-link-empty">
                  {candidates.length === 0 ? 'No highlights or notes on this paper yet.' : 'No matches.'}
                </li>
              ) : (
                filteredCandidates.map((m, i) => {
                  const linked = isLinkedNow(m)
                  return (
                    <li key={m.id} className={i === gapBeforeIndex ? 'field-link-gap' : undefined}>
                      <span className="pdf-color-swatch" style={{ background: m.color }} aria-hidden="true" />
                      {snippetOf(m)}
                      {linked ? (
                        <button
                          type="button"
                          className="field-link-action field-link-unlink"
                          title="Unlink"
                          onClick={() => unlinkMark(m.id, canonical)}
                        >
                          ×
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="field-link-action"
                          title="Link this highlight or note to this field"
                          onClick={() => linkMark(m.id, path, name, index)}
                        >
                          Link
                        </button>
                      )}
                    </li>
                  )
                })
              )}
            </ul>
            <input
              type="text"
              className="field-link-search"
              // The picker opens to search, so put the caret there right away.
              autoFocus
              placeholder="Search highlights/notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}
      </div>
      <button type="button" className="primary" title="Close this list of links" onClick={onClose}>
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
