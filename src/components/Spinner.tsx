/**
 * The app's only spinner: a CSS-only ring, sized in `em` so it sits on the text
 * baseline next to a phase line. It exists to say "the app has not frozen" while
 * a model call is in flight, so it must keep moving even when React is idle —
 * hence keyframes rather than anything driven from state (see `ai.css`).
 *
 * With `prefers-reduced-motion` it pulses instead of spinning.
 */
export function Spinner() {
  return <span className="spinner" role="status" aria-label="Working" />
}
