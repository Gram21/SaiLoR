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
      document.body.classList.remove('resizing')
      onResizeEnd?.()
    }
    document.body.classList.add('resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
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
