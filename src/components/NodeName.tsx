import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ResolvedDef } from '../model/schema'
import { linkifyText } from '../model/linkify'

/**
 * Renders an annotation node's name. When the node has a `description`, the name
 * gets an ⓘ marker and shows a tooltip on hover/focus. The tooltip is rendered
 * in a portal with fixed positioning so it is never clipped by the annotation
 * panel's scroll container.
 *
 * The hover tooltip is necessarily unusable for a description that contains a
 * link: it is `pointer-events: none` and closes the moment the mouse leaves the
 * field name, so moving toward the tooltip to click something in it closes the
 * tooltip first. Right-click opens a second, persistent view of the same text
 * instead — dismissed by outside click or Escape rather than by the mouse
 * moving away — with its text selectable and any URL in it turned into a real
 * link. Left-click keeps its existing meaning (marking the field as read); this
 * is additive, not a replacement.
 */
export function NodeName({
  def,
  className = 'anno-name',
  onClick,
}: {
  def: ResolvedDef
  className?: string
  /** Clicking the label counts as reading the field — used to clear its AI mark. */
  onClick?: () => void
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null)

  // The persistent popover. `origin` is where the right-click landed; `pos` is
  // the on-screen position after clamping to the viewport, computed once the
  // popover's real size is known — see the layout effect below.
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

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
    return (
      <span className={className} onClick={onClick}>
        {label}
      </span>
    )
  }

  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setCoords({ x: r.left, y: r.bottom })
  }
  const hide = () => setCoords(null)

  const openPopover = (e: React.MouseEvent) => {
    e.preventDefault()
    hide() // the hover tooltip would otherwise render behind/over this
    setPos(null) // clamp again for the new click position, not the last one
    setOrigin({ x: e.clientX, y: e.clientY })
  }
  const closePopover = () => setOrigin(null)

  return (
    <span
      ref={ref}
      className={`${className} has-desc`}
      tabIndex={0}
      onClick={onClick}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onContextMenu={openPopover}
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
      {origin && (
        <DescriptionPopover
          ref={popoverRef}
          name={def.name}
          description={def.description}
          origin={origin}
          pos={pos}
          setPos={setPos}
          onClose={closePopover}
        />
      )}
    </span>
  )
}

/**
 * The right-click popover itself, split out of `NodeName` only because a
 * component (not a plain portal call) is what lets it own the outside-click /
 * Escape listeners and the two-pass positioning without re-deriving them on
 * every `NodeName` render.
 */
function DescriptionPopover({
  ref,
  name,
  description,
  origin,
  pos,
  setPos,
  onClose,
}: {
  ref: React.Ref<HTMLDivElement>
  name: string
  description: string
  origin: { x: number; y: number }
  pos: { left: number; top: number } | null
  setPos: (p: { left: number; top: number }) => void
  onClose: () => void
}) {
  const localRef = useRef<HTMLDivElement>(null)

  // Two passes, both before the browser paints: the first mount is at the raw
  // click coordinates so the popover's real size can be measured; this effect
  // then clamps that into the viewport. `useLayoutEffect`, not `useEffect`, is
  // what keeps this invisible to the user — it runs before paint, so there is
  // one commit, not a flash of the unclamped position first.
  useLayoutEffect(() => {
    const el = localRef.current
    if (!el) return
    const margin = 8
    const rect = el.getBoundingClientRect()
    const left = Math.min(Math.max(margin, origin.x), window.innerWidth - rect.width - margin)
    const top = Math.min(Math.max(margin, origin.y), window.innerHeight - rect.height - margin)
    setPos({ left, top })
    // Deliberately just `[origin]`: its identity changes on every right-click
    // (a fresh object), which is exactly the "re-measure for the new click"
    // trigger this needs. `setPos` is a stable setState function, not a value
    // this effect should re-run for.
  }, [origin])

  // Outside click or Escape closes it — the same dismissal rule as `Dropdown`,
  // deliberately not "the mouse moved away", which is what made the hover
  // tooltip unusable for this in the first place.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (localRef.current && !localRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const setRefs = (el: HTMLDivElement | null) => {
    localRef.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el
  }

  return createPortal(
    <div
      ref={setRefs}
      className="desc-popover"
      role="dialog"
      aria-label={`${name} description`}
      // Hidden until `pos` is known, so the unclamped first-pass position (top-left
      // of the eventual box, anchored at the click point) is never visible.
      style={pos ? { left: pos.left, top: pos.top } : { left: origin.x, top: origin.y, visibility: 'hidden' }}
    >
      <div className="desc-popover-head">
        <span className="desc-popover-title">{name}</span>
        <button type="button" className="desc-popover-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="desc-popover-text">
        {linkifyText(description).map((seg, i) =>
          seg.href ? (
            <a key={i} href={seg.href} target="_blank" rel="noreferrer">
              {seg.text}
            </a>
          ) : (
            seg.text
          ),
        )}
      </p>
    </div>,
    document.body,
  )
}
