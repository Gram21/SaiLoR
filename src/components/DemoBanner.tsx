import { useState } from 'react'
import { DEMO_BACK_LABEL, DEMO_BACK_URL, DEMO_RELEASES_URL } from '../demo/text'

// [impl->req~plt-448~1]
// [impl->req~plt-455~1]
/**
 * The online demo's notice that nothing is saved. Hiding it folds it into a
 * small chip that stays on screen until reload, so the notice never vanishes for
 * the whole visit. The link back to the project page stays on screen in both states.
 */
export function DemoBanner() {
  const [folded, setFolded] = useState(false)
  if (folded) {
    return (
      <div className="demo-folded">
        <a href={DEMO_BACK_URL}>{DEMO_BACK_LABEL}</a>
        <button type="button" className="demo-chip" onClick={() => setFolded(false)} title="Demo: nothing is saved">
          Demo
        </button>
      </div>
    )
  }
  return (
    <div className="demo-banner" role="status">
      <a className="demo-back" href={DEMO_BACK_URL}>
        {DEMO_BACK_LABEL}
      </a>
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
