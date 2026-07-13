import { useStore } from '../state/store'

/** Modal-ish banner surfacing load/save errors with friendly details. */
export function ErrorPanel() {
  const error = useStore((s) => s.loadError)
  const clearError = useStore((s) => s.clearError)
  if (!error) return null

  return (
    <div className="error-overlay" onClick={clearError}>
      <div className="error-box" onClick={(e) => e.stopPropagation()}>
        <div className="error-head">
          <strong>{error.message}</strong>
          <button type="button" className="icon-btn" onClick={clearError}>
            ×
          </button>
        </div>
        {error.details.length > 0 && (
          <ul className="error-details">
            {error.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
