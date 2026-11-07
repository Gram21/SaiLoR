import { DEMO_MODE } from './mode'

// English only: the demo notices are not in the locale files, so they read the
// same in every language.

export const DEMO_RELEASES_URL = 'https://github.com/Gram21/SaiLoR/releases'

/** The project page, one level above the demo folder. Relative, so it works under any subpath. */
export const DEMO_BACK_URL = '../'

export const DEMO_BACK_LABEL = '← Back to project page'

/** The notice of the schema editor demo (`?mode=schema`), in place of the annotation demo's notice. */
export const DEMO_SCHEMA_NOTICE = 'Schema demo: nothing is saved on this site. Save downloads project.json.'

export const DEMO_NOT_SAVED = 'Demo: nothing is saved. Download the app to keep your work.'

export const DEMO_NOT_AVAILABLE = 'Not available in the demo. Download the app to use this.'

export const DEMO_NO_PDF = 'The demo does not include a PDF for this paper.'

export const DEMO_READ_ON_ARXIV = 'Read this paper on arXiv'

/**
 * The paper the demo opens on, and the reviewer seat it opens in so the seat
 * prompt does not show. Null outside the demo. Decided at module level: the
 * store reads it inside a try block, where Rollup keeps dead `DEMO_MODE`
 * branches (tryCatchDeoptimization), so the demo values would ship otherwise.
 */
export const DEMO_START = DEMO_MODE ? { paperId: 'KeimKaplan2026_ICSEBoF', seat: '1' } : null

/** The arXiv abstract page named in a paper's venue text, or null when it names none. */
export function demoArxivUrl(venue: string | undefined): string | null {
  return venue?.match(/https:\/\/arxiv\.org\/abs\/[^\s)]+/)?.[0] ?? null
}
