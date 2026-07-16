import { useEffect, useRef, useState, type ReactNode } from 'react'

export type MenuItem =
  | {
      type: 'item'
      label: ReactNode
      shortcut?: string
      /** Tooltip — e.g. a recent project's full path, so same-named files differ. */
      hint?: string
      disabled?: boolean
      onSelect: () => void
      /** When set, the item gets an × that removes it without closing the menu. */
      onRemove?: () => void
      removeTitle?: string
    }
  | { type: 'separator' }
  | { type: 'header'; label: ReactNode }

interface DropdownProps {
  label: ReactNode
  items: MenuItem[]
  title?: string
  disabled?: boolean
  align?: 'left' | 'right'
  /** Extra class(es) on the root `.dropdown` element — a styling hook for
      callers that need a modifier (e.g. a warning border) without a second
      dropdown implementation. */
  className?: string
}

/** A small click-to-open menu that closes on outside-click, Escape, or selection. */
export function Dropdown({ label, items, title, disabled, align = 'left', className }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={`dropdown${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className="dropdown-trigger"
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label} <span className="caret">▾</span>
      </button>
      {open && (
        <div className={`menu ${align === 'right' ? 'menu-right' : ''}`} role="menu">
          {items.map((item, i) => {
            if (item.type === 'separator') return <div key={i} className="menu-sep" role="separator" />
            if (item.type === 'header')
              return (
                <div key={i} className="menu-header">
                  {item.label}
                </div>
              )
            return (
              <div key={i} className="menu-row">
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  title={item.hint}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false)
                    item.onSelect()
                  }}
                >
                  <span className="menu-item-label">{item.label}</span>
                  {item.shortcut && <span className="menu-item-shortcut">{item.shortcut}</span>}
                </button>
                {item.onRemove && (
                  <button
                    type="button"
                    className="menu-remove"
                    title={item.removeTitle}
                    aria-label={item.removeTitle}
                    // Stay open: the user may want to clear several entries.
                    onClick={(e) => {
                      e.stopPropagation()
                      item.onRemove?.()
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
