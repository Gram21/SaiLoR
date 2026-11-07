import { assembleLegacyProjectJson, isLegacyProjectShape, parseMarksFileName } from '../model/project'
import { sharesPaper } from '../model/annotationsDir'

/** What Rust reads for a project: `Opened` (project.rs) or `Snapshot` (git.rs). */
export interface RawProject {
  path?: string
  text: string
  files: { relPath: string; text: string }[]
  siblings?: { name: string; text: string }[]
}

type PaperFiles = Parameters<typeof assembleLegacyProjectJson>[1] extends Map<string, infer V> ? V : never

const isScreening = (raw: unknown) => Boolean((raw as { config?: { screening?: unknown } } | null)?.config?.screening)

/**
 * `project.json` parsed once, for assembling its papers' files in batches: each call returns the
 * project text with the papers `only` names (every paper when omitted) and `files` attached.
 * Null for the legacy shape, whose text is already whole.
 */
export function assembler(p: Omit<RawProject, 'files'>, siblingsCorrupt: string[]) {
  const raw: unknown = JSON.parse(p.text)
  if (isLegacyProjectShape(raw)) return null
  const screening = isScreening(raw)
  const consolidatedName = screening ? 'screening-consolidated.json' : 'consolidated.json'
  const reviewerRe = screening ? /^screening-(\d+)\.json$/ : /^reviewer-(\d+)\.json$/
  const annotationSiblings = (p.siblings ?? [])
    .flatMap((s) => {
      try {
        return [JSON.parse(s.text) as unknown]
      } catch {
        siblingsCorrupt.push(s.name)
        return []
      }
    })
    .filter((s) => !isScreening(s))
  return (rawFiles: RawProject['files'], corrupt: string[], only?: Set<string>): string => {
    const files = rawFiles.map((f) => {
      const slash = f.relPath.lastIndexOf('/')
      const name = f.relPath.slice(slash + 1)
      return { ...f, id: slash < 0 ? '' : f.relPath.slice(0, slash), name, marks: parseMarksFileName(name, screening) }
    })
    files.sort((a, b) => Number(!a.marks?.legacy) - Number(!b.marks?.legacy))
    const papers = new Map<string, PaperFiles>()
    for (const f of files) {
      const reviewer = reviewerRe.exec(f.name)
      if (f.name !== consolidatedName && !reviewer && !f.marks) continue
      if (f.marks?.legacy && annotationSiblings.some((s) => sharesPaper([f.id], s))) continue
      let value: unknown
      try {
        value = JSON.parse(f.text)
      } catch {
        corrupt.push(f.relPath)
        continue
      }
      let entry = papers.get(f.id)
      if (!entry) papers.set(f.id, (entry = { reviewers: new Map(), reviewMarks: new Map() }))
      if (f.name === consolidatedName) entry.consolidated = value
      else if (reviewer) entry.reviewers.set(reviewer[1], value)
      else if (f.marks!.seat === 'consolidated') entry.marksConsolidated = value
      else entry.reviewMarks.set(f.marks!.seat, value)
    }
    const meta = only
      ? { ...(raw as object), papers: (raw as { papers: { id?: unknown }[] }).papers.filter((x) => only.has(x?.id as string)) }
      : raw
    return JSON.stringify(assembleLegacyProjectJson(meta, papers))
  }
}

