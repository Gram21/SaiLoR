import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Keep in sync with `.combo-menu`'s `max-height` in index.css — used to
 *  decide whether there's enough room to open downward at all. Exported for
 *  `ModelPicker`, which reuses the same `.combo-menu` class/flip logic. */
export const COMBO_MENU_MAX_HEIGHT = 240

/** The menu never grows wider than this, however long an option's label is —
 *  a generous cap so a single absurd label can't produce an absurd menu;
 *  `.combo-option`'s own ellipsis (index.css) takes over past this point. */
const COMBO_MENU_MAX_WIDTH = 480

/** How much of `.combo-menu`/`.combo-option`'s own padding a label needs
 *  clear of, on top of its own rendered width, to read as comfortably
 *  unclipped rather than merely not-yet-clipped. */
const COMBO_MENU_WIDTH_PADDING = 28

/**
 * The widest of `labels`, rendered exactly as `.combo-option` would. A
 * hidden, `.combo-option`-classed probe reuses the real CSS (font, weight,
 * letter-spacing) instead of guessing a `canvas.measureText` font string —
 * cheap enough to run once per menu open, over every option rather than
 * just the filtered ones, so the menu's width doesn't jump around as a
 * reviewer types a filter.
 */
function measureWidestLabel(labels: string[]): number {
  if (labels.length === 0) return 0
  const probe = document.createElement('div')
  probe.className = 'combo-option'
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.width = 'max-content'
  probe.style.whiteSpace = 'nowrap'
  document.body.appendChild(probe)
  let max = 0
  for (const label of labels) {
    probe.textContent = label
    max = Math.max(max, probe.scrollWidth)
  }
  document.body.removeChild(probe)
  return max
}

/** An option whose displayed text differs from the value it commits. */
export interface ComboOption {
  id: string
  label: string
}

interface ComboBoxProps {
  value: string | null
  /**
   * Plain strings when the value *is* the label (enum fields), or `{id, label}`
   * when they differ (picking an LLM target by id while showing its name).
   */
  options: (string | ComboOption)[]
  onChange: (v: string | null) => void
  /** Extra classes for the input (e.g. the AI mark). */
  className?: string
  /** The user reached the control (focus or click) — used to clear the AI mark. */
  onInteract?: () => void
  /** E.g. the screening Reason field before a paper is excluded — there is
   *  nothing to pick yet, and picking must not be possible either. */
  disabled?: boolean
  /** Accessible name — the input has no visible label of its own. */
  ariaLabel?: string
}

/**
 * A text input that opens a dropdown of allowed values on focus and filters them
 * as you type. The committed value is always one of the options (or null). The
 * menu is portaled with fixed positioning so the annotation panel's scroll
 * container never clips it.
 */
export function ComboBox({
  value,
  options: rawOptions,
  onChange,
  className = '',
  onInteract,
  disabled = false,
  ariaLabel,
}: ComboBoxProps) {
  const options: ComboOption[] = rawOptions.map((o) =>
    typeof o === 'string' ? { id: o, label: o } : o,
  )
  const labelOf = (id: string | null) => options.find((o) => o.id === id)?.label ?? ''
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [rect, setRect] = useState<{
    left: number
    width: number
    maxHeight: number
    /** Exactly one of `top`/`bottom` is set — `bottom` when the menu opens
     *  upward (not enough room below the input) so it grows away from
     *  whichever screen edge triggered the flip, without needing to know its
     *  own rendered height up front. */
    top?: number
    bottom?: number
  } | null>(null)

  const needle = filter.trim().toLowerCase()
  const filtered = needle
    ? options.filter((o) => o.label.toLowerCase().includes(needle))
    : options

  const openMenu = () => {
    setFilter('')
    setHighlight(Math.max(0, options.findIndex((o) => o.id === value)))
    setOpen(true)
  }

  const select = (opt: ComboOption) => {
    onChange(opt.id)
    setOpen(false)
    setFilter('')
  }

  // Position the portaled menu under the input, following scroll/resize —
  // or above it, when there isn't enough room below (a field near the
  // bottom of the annotation panel) but there is above, so the menu never
  // opens off-screen.
  //
  // Horizontally, the menu is no longer bound to the input's own (often
  // narrow) width: it grows to fit the widest option label, up to
  // `COMBO_MENU_MAX_WIDTH` — first leftward, keeping its right edge pinned
  // to the input's own right edge, since that reads as "expanding out of
  // the field" rather than sliding the whole menu sideways. Only once that
  // alone can't fit (the nearest panel/dialog's left edge is reached first)
  // does it also grow rightward, past the input, up to that container's
  // right edge. If even the full container span isn't enough, `.combo-option`
  // ellipsizes whatever is left over — this never makes the menu narrower
  // than the input itself.
  useLayoutEffect(() => {
    if (!open) return
    const desiredWidth =
      Math.min(COMBO_MENU_MAX_WIDTH, measureWidestLabel(options.map((o) => o.label)) + COMBO_MENU_WIDTH_PADDING)
    const update = () => {
      const el = inputRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const spaceBelow = window.innerHeight - r.bottom
      const spaceAbove = r.top
      const openUp = spaceBelow < COMBO_MENU_MAX_HEIGHT && spaceAbove > spaceBelow
      const maxHeight = Math.max(0, (openUp ? spaceAbove : spaceBelow) - 8)

      // The nearest panel or dialog the input sits in — `.panel` covers the
      // annotation/screening panes, `.modal` covers a dialog like AiDialog's
      // — falling back to the viewport when neither is an ancestor.
      const MARGIN = 8
      const boundRect = el.closest('.panel, .modal')?.getBoundingClientRect()
      const boundLeft = (boundRect?.left ?? 0) + MARGIN
      const boundRight = (boundRect?.right ?? window.innerWidth) - MARGIN

      const width = Math.max(r.width, Math.min(desiredWidth, boundRight - boundLeft))
      const growLeftOnly = r.right - width >= boundLeft
      const left = growLeftOnly ? r.right - width : boundLeft

      setRect(
        openUp
          ? { left, width, bottom: window.innerHeight - r.top + 4, maxHeight }
          : { left, width, top: r.bottom + 4, maxHeight },
      )
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Keep the highlighted option within bounds as the filter narrows.
  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(filtered.length > 0 ? filtered.length - 1 : 0)
  }, [filtered.length, highlight])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) openMenu()
      else setHighlight((h) => Math.min(filtered.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(0, h - 1))
    } else if (e.key === 'Enter') {
      if (open && filtered[highlight]) {
        e.preventDefault()
        select(filtered[highlight])
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        setOpen(false)
      }
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && filter === '' && value !== null) {
      // Clear the selection when backspacing on an empty filter.
      e.preventDefault()
      onChange(null)
    }
  }

  return (
    <div className="combo">
      <input
        ref={inputRef}
        className={`field-input combo-input${className ? ` ${className}` : ''}`}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        disabled={disabled}
        value={open ? filter : labelOf(value)}
        placeholder={labelOf(value) || 'Select…'}
        onFocus={() => {
          onInteract?.()
          openMenu()
        }}
        onClick={() => {
          onInteract?.()
          if (!open) openMenu()
        }}
        onChange={(e) => {
          setFilter(e.target.value)
          setHighlight(0)
          if (!open) setOpen(true)
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {value !== null && !disabled && (
        <button
          type="button"
          className="combo-clear"
          aria-label="Clear selection"
          title="Clear selection"
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={() => onChange(null)}
        >
          ×
        </button>
      )}
      <span className="combo-caret" aria-hidden="true">
        ▾
      </span>
      {open &&
        rect &&
        createPortal(
          <div
            className="combo-menu"
            role="listbox"
            style={{
              left: rect.left,
              width: rect.width,
              maxHeight: rect.maxHeight,
              ...(rect.top !== undefined ? { top: rect.top } : { bottom: rect.bottom }),
            }}
          >
            {filtered.length === 0 ? (
              <div className="combo-empty">No matches</div>
            ) : (
              filtered.map((opt, i) => (
                <div
                  key={opt.id}
                  role="option"
                  aria-selected={opt.id === value}
                  className={
                    'combo-option' +
                    (i === highlight ? ' active' : '') +
                    (opt.id === value ? ' selected' : '')
                  }
                  // preventDefault keeps input focus so onBlur doesn't fire first.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    select(opt)
                  }}
                  onMouseEnter={() => setHighlight(i)}
                >
                  {opt.label}
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
