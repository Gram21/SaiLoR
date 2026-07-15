import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelInfo } from '../llm/types'

interface ModelPickerProps {
  id: string
  value: string
  onChange: (v: string) => void
  models: ModelInfo[]
  loading: boolean
  providerLabel: string
  placeholder?: string
}

/**
 * The model field: a free-text input the reviewer can always type into,
 * dressed up with a searchable dropdown of what `fetchModels` found, and a
 * red "not a model {provider} listed" flag once the field is left with text
 * that doesn't match.
 *
 * Deliberately not `ComboBox` (used elsewhere for enum annotation fields):
 * that component commits only a listed option and silently reverts anything
 * else on blur — right for a closed enum, wrong here. A provider's catalog
 * can be incomplete (a brand-new model, a private fine-tune) or simply not
 * fetched yet (no key entered), and the reviewer must still be able to type a
 * model name straight from the provider's own docs and have it stick.
 */
export function ModelPicker({
  id,
  value,
  onChange,
  models,
  loading,
  providerLabel,
  placeholder,
}: ModelPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null)
  // Set on the first blur, and never reset: the point is "this field has been
  // left in a state the reviewer should look at", not a live typing check.
  const [touched, setTouched] = useState(false)

  const needle = value.trim().toLowerCase()
  const filtered = needle
    ? models.filter(
        (m) => m.id.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle),
      )
    : models

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const el = inputRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setRect({ left: r.left, top: r.bottom, width: Math.max(r.width, 280) })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open])

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(filtered.length > 0 ? filtered.length - 1 : 0)
  }, [filtered.length, highlight])

  const select = (m: ModelInfo) => {
    onChange(m.id)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      else setHighlight((h) => Math.min(filtered.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(0, h - 1))
    } else if (e.key === 'Enter') {
      if (open && filtered[highlight]) {
        e.preventDefault()
        select(filtered[highlight])
      }
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      setOpen(false)
    }
  }

  // Only judged against a catalog we actually have — an empty list means
  // "unknown", never "invalid".
  const invalid =
    touched && models.length > 0 && value.trim() !== '' && !models.some((m) => m.id === value.trim())

  return (
    <div className="model-picker">
      <input
        ref={inputRef}
        id={id}
        className={`model-picker-input${invalid ? ' model-picker-invalid' : ''}`}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={value}
        placeholder={placeholder}
        title={invalid ? `"${value.trim()}" is not a model ${providerLabel} listed.` : undefined}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onBlur={() => {
          setOpen(false)
          setTouched(true)
        }}
        onKeyDown={onKeyDown}
      />
      {loading && (
        <span className="model-picker-status" aria-live="polite">
          Loading…
        </span>
      )}
      {open &&
        rect &&
        models.length > 0 &&
        createPortal(
          <div
            className="combo-menu"
            role="listbox"
            style={{ left: rect.left, top: rect.top + 4, width: rect.width }}
          >
            {filtered.length === 0 ? (
              <div className="combo-empty">No matches</div>
            ) : (
              filtered.slice(0, 200).map((m, i) => (
                <div
                  key={m.id}
                  role="option"
                  aria-selected={m.id === value}
                  className={
                    'combo-option' +
                    (i === highlight ? ' active' : '') +
                    (m.id === value ? ' selected' : '')
                  }
                  onMouseDown={(e) => {
                    e.preventDefault()
                    select(m)
                  }}
                  onMouseEnter={() => setHighlight(i)}
                >
                  {m.label !== m.id ? `${m.label} (${m.id})` : m.id}
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
