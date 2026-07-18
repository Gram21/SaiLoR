import { type PointerEvent as ReactPointerEvent } from 'react'

interface SplitterProps {
  /** Called with the pointer's clientX during a drag. */
  onResize: (clientX: number) => void
  /** Called when the drag ends (e.g. to persist the new size). */
  onResizeEnd?: () => void
}

/** A vertical drag handle for resizing adjacent panes. */
export function Splitter({ onResize, onResizeEnd }: SplitterProps) {
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault()
    const move = (ev: PointerEvent) => onResize(ev.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      // `pointercancel`, not just `pointerup`. `.splitter` sets
      // `touch-action: none`, so touch drags are supported on purpose — and a
      // touch drag interrupted by a second finger or a system edge gesture
      // fires only `pointercancel`. Without this the listeners stayed bound,
      // and since `pointermove` fires on plain hover, moving the mouse anywhere
      // went on resizing the pane forever, with `body.resizing` forcing
      // `col-resize` over the whole app and blocking text selection. There was
      // no way out but reloading, which costs the unsaved annotations.
      window.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing')
      onResizeEnd?.()
    }
    document.body.classList.add('resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
    />
  )
}
