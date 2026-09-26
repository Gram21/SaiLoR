import { classifyImport, type DupRecord } from './duplicates'
import type { PdfMark } from './pdfMarks'
import type { Paper, Project } from './project'

/**
 * The PDF highlights a screening project holds for the papers of a project
 * started from it (`provenance.kind === 'screening-import'`), so the
 * annotation project can show what the screeners marked.
 *
 * Papers are matched by id, then by the id the import gave a paper whose id
 * the screening project already used (`p1` → `p1-2`), then as the import
 * matches duplicates: DOI, or title with authors and year.
 */

export interface ScreeningMark {
  /** A reviewer number, or `consolidated`. */
  seat: string
  mark: PdfMark
}

const record = (p: Paper): DupRecord => ({ title: p.title, authors: p.authors, doi: p.doi, year: p.year })

function counterpart(paper: Paper, screening: Project): Paper | undefined {
  const byId = new Map(screening.papers.map((p) => [p.id, p]))
  const direct = byId.get(paper.id) ?? byId.get(paper.id.replace(/-\d+$/, ''))
  if (direct) return direct
  const [verdict] = classifyImport(screening.papers.map(record), [record(paper)])
  return verdict?.kind === 'certain' && verdict.target.where === 'existing' ? screening.papers[verdict.target.index] : undefined
}

/** Screening highlights by `project`'s own paper id; papers with none are left out. */
export function screeningMarksByPaper(project: Project, screening: Project): Record<string, ScreeningMark[]> {
  const out: Record<string, ScreeningMark[]> = {}
  for (const paper of project.papers) {
    const source = counterpart(paper, screening)
    if (!source) continue
    const marks: ScreeningMark[] = [
      ...source.marks.map((mark) => ({ seat: 'consolidated', mark })),
      ...Object.entries(source.reviewMarks)
        .sort(([a], [b]) => Number(a) - Number(b))
        .flatMap(([seat, list]) => list.map((mark) => ({ seat, mark }))),
    ]
    if (marks.length > 0) out[paper.id] = marks
  }
  return out
}

/** Who made a screening highlight, in words. */
export function screeningSeatLabel(seat: string): string {
  return seat === 'consolidated' ? 'Screening, consolidated' : `Screening, Reviewer ${seat}`
}
