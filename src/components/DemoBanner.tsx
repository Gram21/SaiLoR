import { useState } from 'react'
import { DEMO_RELEASES_URL } from '../demo/text'

// [impl->req~plt-448~1]
/**
 * The online demo's notice that nothing is saved. Hiding it folds it into a
 * small chip that stays on screen until reload, so the notice never vanishes for
 * the whole visit.
 */
export function DemoBanner() {
  const [folded, setFolded] = useState(false)
  if (folded) {
    return (
      <button type="button" className="demo-chip" onClick={() => setFolded(false)} title="Demo: nothing is saved">
        Demo
      </button>
    )
  }
  return (
    <div className="demo-banner" role="status">
      <span>Demo: nothing is saved. </span>
      <a href={DEMO_RELEASES_URL} target="_blank" rel="noopener noreferrer">
        Download the app
      </a>
      <span> to keep your work.</span>
      <button type="button" className="demo-banner-hide" aria-label="Hide the demo notice" onClick={() => setFolded(true)}>
        ×
      </button>
    </div>
  )
}
