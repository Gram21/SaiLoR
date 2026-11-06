import { assembleLegacyProjectJson } from '../model/project'
import meta from './data/project.json'

/** The one demo paper with a PDF, relative to the project file. */
export const DEMO_PDF_PATH = 'pdfs/KeimKaplan_FromScatteredToStructured.pdf'

/** Where `vite.config.ts` writes that PDF in the demo build (`papers/`, next to index.html). */
export const DEMO_PDF_URL = `${import.meta.env.BASE_URL}papers/KeimKaplan_FromScatteredToStructured.pdf`

export const DEMO_FILE_NAME = 'demo-project.json'

const seatFiles = import.meta.glob<unknown>('./data/annotations/*/reviewer-*.json', {
  eager: true,
  import: 'default',
})

/**
 * The whole demo project as the text `loadProject` accepts: the project file
 * plus every reviewer file, assembled the way opening a saved project does.
 */
export function demoProjectText(): string {
  const papers = new Map<string, { reviewers: Map<string, unknown>; reviewMarks: Map<string, unknown> }>()
  for (const [path, value] of Object.entries(seatFiles)) {
    const match = /\/annotations\/([^/]+)\/reviewer-(\d+)\.json$/.exec(path)
    if (!match) continue
    const [, paperId, seat] = match
    let entry = papers.get(paperId)
    if (!entry) papers.set(paperId, (entry = { reviewers: new Map(), reviewMarks: new Map() }))
    entry.reviewers.set(seat, value)
  }
  return JSON.stringify(assembleLegacyProjectJson(meta, papers))
}
