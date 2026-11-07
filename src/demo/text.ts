// English only: the demo notices are not in the locale files, so they read the
// same in every language.

export const DEMO_RELEASES_URL = 'https://github.com/Gram21/SaiLoR/releases'

export const DEMO_NOT_SAVED = 'Demo: nothing is saved. Download the app to keep your work.'

export const DEMO_NOT_AVAILABLE = 'Not available in the demo. Download the app to use this.'

export const DEMO_NO_PDF = 'The demo does not include a PDF for this paper.'

export const DEMO_READ_ON_ARXIV = 'Read this paper on arXiv'

/** The paper the demo opens on: the one paper with a bundled PDF. */
export const DEMO_START_PAPER_ID = 'KeimKaplan2026_ICSEBoF'

/** The reviewer seat the demo opens in, so the seat prompt does not show. */
export const DEMO_START_SEAT = '1'

/** The arXiv abstract page named in a paper's venue text, or null when it names none. */
export function demoArxivUrl(venue: string | undefined): string | null {
  return venue?.match(/https:\/\/arxiv\.org\/abs\/[^\s)]+/)?.[0] ?? null
}
