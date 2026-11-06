import { useRef, type KeyboardEvent, type ReactNode } from 'react'

const FOCUSABLE =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

interface ModalProps {
  /** Called on a click on the overlay. Without it, the overlay does not close the dialog. */
  onClose?: () => void
  /** Extra classes after `modal-overlay`. */
  overlayClassName?: string
  /** Extra classes after `modal`. */
  className?: string
  role?: 'dialog' | 'alertdialog'
  /** Let the help overlay stay on top of this dialog (`useKeybindings`). */
  yieldsToHelp?: boolean
  'aria-label'?: string
  'aria-labelledby'?: string
  children: ReactNode
}

/** Overlay and dialog frame shared by all dialogs. Keeps Tab inside the dialog. */
export function Modal({ onClose, overlayClassName, className, role = 'dialog', yieldsToHelp, children, ...aria }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)

  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last?.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first?.focus()
    }
  }

  return (
    <div className={overlayClassName ? `modal-overlay ${overlayClassName}` : 'modal-overlay'} onClick={onClose} data-yields-to-help={yieldsToHelp ? '' : undefined}>
      <div
        ref={ref}
        className={className ? `modal ${className}` : 'modal'}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
        role={role}
        aria-modal="true"
        {...aria}
      >
        {children}
      </div>
    </div>
  )
}
