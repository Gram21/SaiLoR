import { assembleLegacyProjectJson } from '../model/project'
import meta from './data/project.json'

// [impl->req~plt-454~1]
/**
 * The bundled demo PDFs, keyed by the `pdf` path in project.json. Each file is in
 * samples/pdfs/, and vite.config.ts writes the paper PDFs there to `papers/` in the
 * demo build. The licence of each file is in src/demo/PDF-LICENSES.md.
 */
const DEMO_PDF_FILES = new Map<string, string>([
  ['pdfs/2505.16697.pdf', '2505.16697.pdf'],
  ['pdfs/2510.24819.pdf', '2510.24819.pdf'],
  ['pdfs/2510.26275.pdf', '2510.26275.pdf'],
  ['pdfs/2511.02434.pdf', '2511.02434.pdf'],
  ['pdfs/2606.23197.pdf', '2606.23197.pdf'],
  ['pdfs/2606.28064.pdf', '2606.28064.pdf'],
  ['pdfs/KeimKaplan_FromScatteredToStructured.pdf', 'KeimKaplan_FromScatteredToStructured.pdf'],
])

/** The URL of a bundled demo PDF, or null when the demo bundles no PDF for that path. */
export function demoPdfUrl(pdfPath: string): string | null {
  const file = DEMO_PDF_FILES.get(pdfPath)
  return file === undefined ? null : `${import.meta.env.BASE_URL}papers/${file}`
}

export const DEMO_FILE_NAME = 'demo-project.json'

const seatFiles = import.meta.glob<unknown>('./data/annotations/*/reviewer-*.json', {
  eager: true,
  import: 'default',
})

const consolidatedFiles = import.meta.glob<unknown>('./data/annotations/*/consolidated.json', {
  eager: true,
  import: 'default',
})

/**
 * The whole demo project as the text `loadProject` accepts: the project file
 * plus every reviewer file, assembled the way opening a saved project does.
 */
export function demoProjectText(): string {
  const papers = new Map<string, { consolidated?: unknown; reviewers: Map<string, unknown>; reviewMarks: Map<string, unknown> }>()
  for (const [path, value] of Object.entries(seatFiles)) {
    const match = /\/annotations\/([^/]+)\/reviewer-(\d+)\.json$/.exec(path)
    if (!match) continue
    const [, paperId, seat] = match
    let entry = papers.get(paperId)
    if (!entry) papers.set(paperId, (entry = { reviewers: new Map(), reviewMarks: new Map() }))
    entry.reviewers.set(seat, value)
  }
  for (const [path, value] of Object.entries(consolidatedFiles)) {
    const paperId = /\/annotations\/([^/]+)\/consolidated\.json$/.exec(path)?.[1]
    const entry = paperId === undefined ? undefined : papers.get(paperId)
    if (entry) entry.consolidated = value
  }
  return JSON.stringify(assembleLegacyProjectJson(meta, papers))
}
