import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ResolvedDef } from '../model/schema'

/**
 * Renders an annotation node's name. When the node has a `description`, the name
 * gets an ⓘ marker and shows a tooltip on hover/focus. The tooltip is rendered
 * in a portal with fixed positioning so it is never clipped by the annotation
 * panel's scroll container.
 */
export function NodeName({ def, className = 'anno-name' }: { def: ResolvedDef; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null)

  // A required field is marked so the reviewer sees it before validating.
  const label = (
    <>
      {def.name}
      {def.required && (
        <abbr className="anno-required" title="Required — this field must be filled in">
          *
        </abbr>
      )}
    </>
  )

  if (!def.description) {
    return <span className={className}>{label}</span>
  }

  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setCoords({ x: r.left, y: r.bottom })
  }
  const hide = () => setCoords(null)

  return (
    <span
      ref={ref}
      className={`${className} has-desc`}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-label={`${def.name}. ${def.description}`}
    >
      {def.name}
      <span className="info-dot" aria-hidden="true">
        ⓘ
      </span>
      {coords &&
        createPortal(
          <span className="tip" role="tooltip" style={{ left: coords.x, top: coords.y + 6 }}>
            {def.description}
          </span>,
          document.body,
        )}
    </span>
  )
}
