import type { PdfFolderScan } from '../platform/adapter'
import { normalizeTree } from './annotations'
import { annotationsDirProblem } from './annotationsDir'
import type { MetadataField, MetadataValues } from './metadata'
import type { PdfMeta } from './pdfMeta'
import type { Paper, Project } from './project'
import { parseYear } from './year'

export type ValueSource = 'pdfinfo' | 'crossref' | 'filename' | 'manual'
export type MetadataSources = Partial<Record<MetadataField, ValueSource>>

export interface PdfFile {
  path: string
  sha256: string
}

export interface PdfProposal {
  file: PdfFile
  values: MetadataValues
  sources: MetadataSources
}

// [impl->req~dat-500~1]
export function parsePdfFolder(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

// [impl->req~dat-500~1]
export function pdfFolderProblem(folder: string): string | null {
  for (const segment of folder.split('/')) {
    const problem = annotationsDirProblem(segment)
    if (problem) return problem
  }
  return null
}

export function paperIdFromName(name: string): string {
  return (
    name
      .replace(/\.pdf$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'paper'
  )
}

export function titleFromName(name: string): string {
  return name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim()
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function ignoredPdfsOf(project: Pick<Project, 'extra'>): string[] {
  const raw = project.extra.ignoredPdfs
  return Array.isArray(raw) ? raw.filter((h): h is string => typeof h === 'string') : []
}

export function pdfHashOf(paper: Pick<Paper, 'extra'>): string | undefined {
  const h = paper.extra.pdfSha256
  return typeof h === 'string' ? h : undefined
}

// [impl->req~dat-510~1]
export function newPdfFiles(papers: Pick<Paper, 'extra'>[], scan: PdfFolderScan, ignored: string[]): PdfFile[] {
  const seen = new Set<string>(ignored)
  for (const h of scan.known) if (h && h !== 'missing') seen.add(h)
  for (const p of papers) {
    const h = pdfHashOf(p)
    if (h) seen.add(h)
  }
  const out: PdfFile[] = []
  for (const f of scan.files) {
    if (seen.has(f.sha256)) continue
    seen.add(f.sha256)
    out.push(f)
  }
  return out
}

// [impl->req~lst-90~1]
export function missingPaperIds(papers: Pick<Paper, 'id'>[], known: PdfFolderScan['known']): string[] {
  return papers.filter((_, i) => known[i] === 'missing').map((p) => p.id)
}

// [impl->req~dat-530~1]
export function crossrefUrl(doi: string): string {
  return `https://api.crossref.org/works/${encodeURIComponent(doi)}`
}

// [impl->req~dat-520~1]
export function parseCrossrefWork(body: string): MetadataValues {
  let m: Record<string, unknown>
  try {
    m = (JSON.parse(body) as { message?: Record<string, unknown> }).message ?? {}
  } catch {
    return {}
  }
  const out: MetadataValues = {}
  const title = Array.isArray(m.title) ? m.title[0] : undefined
  if (typeof title === 'string' && title.trim()) out.title = title.replace(/\s+/g, ' ').trim()
  if (Array.isArray(m.author)) {
    const authors = (m.author as { given?: unknown; family?: unknown }[])
      .map((a) => [a.given, a.family].filter((x) => typeof x === 'string').join(' ').trim())
      .filter(Boolean)
    if (authors.length > 0) out.authors = authors
  }
  for (const key of ['issued', 'published', 'published-print', 'published-online']) {
    const year = parseYear((m[key] as { 'date-parts'?: unknown[][] } | undefined)?.['date-parts']?.[0]?.[0])
    if (year !== undefined) {
      out.year = year
      break
    }
  }
  if (typeof m.DOI === 'string' && m.DOI.trim()) out.doi = m.DOI
  return out
}

// [impl->req~dat-520~1]
export function proposeNewPaper(file: PdfFile, meta: PdfMeta, crossref?: MetadataValues): PdfProposal {
  const values: MetadataValues = {}
  const sources: MetadataSources = {}
  const put = (found: MetadataValues, source: ValueSource) => {
    for (const [f, v] of Object.entries(found) as [MetadataField, unknown][]) {
      if (v === undefined || (Array.isArray(v) && v.length === 0)) continue
      ;(values as Record<string, unknown>)[f] = v
      sources[f] = source
    }
  }
  put({ title: meta.title, authors: meta.authors, doi: meta.doi }, 'pdfinfo')
  if (crossref) put(crossref, 'crossref')
  if (!values.title) put({ title: titleFromName(baseName(file.path)) }, 'filename')
  return { file, values, sources }
}

// [impl->req~dat-520~1]
// [impl->req~dat-540~1]
export function newPaper(
  project: Pick<Project, 'schema' | 'reviewers'>,
  proposal: PdfProposal,
  existingIds: Set<string>,
): Paper {
  const stem = paperIdFromName(baseName(proposal.file.path))
  let id = stem
  for (let n = 2; existingIds.has(id); n++) id = `${stem}-${n}`
  const reviews: Paper['reviews'] = {}
  if (project.reviewers > 1) for (let i = 1; i <= project.reviewers; i++) reviews[String(i)] = normalizeTree(project.schema, undefined)
  const { title, authors, year, doi } = proposal.values
  return {
    id,
    title: title ?? '',
    authors: authors ?? [],
    ...(doi ? { doi } : {}),
    ...(year !== undefined ? { year } : {}),
    pdf: proposal.file.path,
    annotations: normalizeTree(project.schema, undefined),
    reviews,
    aiUsage: [],
    equal: [],
    alignment: {},
    marks: [],
    reviewMarks: {},
    finished: false,
    reviewsFinished: {},
    extra: { pdfSha256: proposal.file.sha256, metadataSource: proposal.sources },
  }
}
