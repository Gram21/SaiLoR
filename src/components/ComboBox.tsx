import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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
}: ComboBoxProps) {
  const options: ComboOption[] = rawOptions.map((o) =>
    typeof o === 'string' ? { id: o, label: o } : o,
  )
  const labelOf = (id: string | null) => options.find((o) => o.id === id)?.label ?? ''
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null)

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

  // Position the portaled menu under the input, following scroll/resize.
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const el = inputRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setRect({ left: r.left, top: r.bottom, width: r.width })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
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
      <span className="combo-caret" aria-hidden="true">
        ▾
      </span>
      {open &&
        rect &&
        createPortal(
          <div
            className="combo-menu"
            role="listbox"
            style={{ left: rect.left, top: rect.top + 4, width: rect.width }}
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
