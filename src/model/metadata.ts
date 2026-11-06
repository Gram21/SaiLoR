import type { PdfMeta } from './pdfMeta'
import { aiSeatId, deepEqualJson, type Paper, type Project } from './project'
import { parseYear } from './year'
import { normalizeDoi, normalizeTitleForMatch } from './duplicates'

export type MetadataEditMode = 'off' | 'annotation'

export const METADATA_FIELDS = ['title', 'authors', 'year', 'doi'] as const
export type MetadataField = (typeof METADATA_FIELDS)[number]

/** A present key with an `undefined` value clears `year` or `doi`. */
export interface MetadataValues {
  title?: string
  authors?: string[]
  year?: number
  doi?: string
}

export interface SeatMetadata {
  overrides?: MetadataValues
  ignored?: MetadataValues
}

type MetadataProject = Pick<Project, 'metadataEdit' | 'reviewers' | 'aiSeat' | 'aiEnabled' | 'screening'>

// [impl->req~dat-430~1]
export function parseMetadataEditMode(raw: unknown): MetadataEditMode {
  return raw === 'project' || raw === 'annotation' ? 'annotation' : 'off'
}

export function parseMetadataValues(raw: unknown): MetadataValues | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: MetadataValues = {}
  if (typeof r.title === 'string' && r.title.trim()) out.title = r.title
  if (Array.isArray(r.authors) && r.authors.every((a) => typeof a === 'string')) out.authors = r.authors as string[]
  const year = parseYear(r.year)
  if (year !== undefined) out.year = year
  if (typeof r.doi === 'string' && r.doi.trim()) out.doi = r.doi
  return Object.keys(out).length > 0 ? out : undefined
}

/** Seat keys "1".."N" to `{ overrides, ignored }`; drops anything else. */
export function parseReviewMetadata(raw: unknown): Record<string, SeatMetadata> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, SeatMetadata> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[1-9]\d*$/.test(k) || typeof v !== 'object' || v === null) continue
    const overrides = parseMetadataValues((v as SeatMetadata).overrides)
    const ignored = parseMetadataValues((v as SeatMetadata).ignored)
    if (overrides || ignored) out[k] = { ...(overrides ? { overrides } : {}), ...(ignored ? { ignored } : {}) }
  }
  return out
}

export function paperMetadata(p: Pick<Paper, MetadataField>): MetadataValues {
  return {
    title: p.title,
    authors: p.authors,
    ...(p.year !== undefined ? { year: p.year } : {}),
    ...(p.doi ? { doi: p.doi } : {}),
  }
}

// [impl->req~lst-80~1]
/** The values the seat sees: the project's, under that seat's overrides. */
export function effectiveMetadata(paper: Paper, seat: string | null): MetadataValues & { title: string; authors: string[] } {
  const overrides = seat ? paper.reviewMetadata?.[seat]?.overrides : undefined
  return { ...paperMetadata(paper), ...overrides } as MetadataValues & { title: string; authors: string[] }
}

// [impl->req~lst-80~1]
export function editedFields(paper: Paper, seat: string | null): MetadataField[] {
  const original = paper.extra.metadataOriginal
  const keys = new Set(typeof original === 'object' && original !== null ? Object.keys(original) : [])
  for (const k of Object.keys((seat && paper.reviewMetadata?.[seat]?.overrides) || {})) keys.add(k)
  return METADATA_FIELDS.filter((f) => keys.has(f))
}

function normalized(field: MetadataField, v: unknown): unknown {
  if (v === undefined || v === null) return null
  if (field === 'title') return normalizeTitleForMatch(String(v)).replace(/ /g, '')
  if (field === 'authors') {
    const words = (v as string[]).join(' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
    return words.length > 0 ? words.sort().join(' ') : null
  }
  if (field === 'doi') {
    return normalizeDoi(String(v)) || null
  }
  return v
}

/** Equal up to case, punctuation, author order and DOI prefix. */
export function sameValue(field: MetadataField, a: unknown, b: unknown): boolean {
  return deepEqualJson(normalized(field, a), normalized(field, b))
}

// [impl->req~dat-470~1]
/** The PDF values that differ from `current` and were not ignored before. Never a year. */
export function proposeFromPdf(current: MetadataValues, pdf: PdfMeta, ignored?: MetadataValues): MetadataValues {
  const out: MetadataValues = {}
  const found: MetadataValues = {
    ...(pdf.title ? { title: pdf.title } : {}),
    ...(pdf.authors && pdf.authors.length > 0 ? { authors: pdf.authors } : {}),
    ...(pdf.doi ? { doi: pdf.doi } : {}),
  }
  for (const f of ['title', 'authors', 'doi'] as const) {
    const v = found[f]
    if (v === undefined || sameValue(f, v, current[f])) continue
    if (ignored && f in ignored && sameValue(f, v, ignored[f])) continue
    ;(out as Record<string, unknown>)[f] = v
  }
  return out
}

function setField(paper: Paper, field: MetadataField, value: unknown): void {
  if (field === 'title') paper.title = value as string
  else if (field === 'authors') paper.authors = (value as string[] | undefined) ?? []
  else if (field === 'year') paper.year = value as number | undefined
  else paper.doi = value as string | undefined
}

function emptyTitle(field: MetadataField, value: unknown): boolean {
  return field === 'title' && (typeof value !== 'string' || !value.trim())
}

// [impl->req~dat-440~1]
// [impl->req~dat-450~1]
/** Writes into the paper itself and keeps each field's first value in `extra.metadataOriginal`. */
export function applyProjectEdit(paper: Paper, values: MetadataValues): void {
  const raw = paper.extra.metadataOriginal
  const original: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {}
  for (const f of METADATA_FIELDS) {
    if (!(f in values) || emptyTitle(f, values[f])) continue
    const next = values[f] ?? null
    const prev = paper[f] ?? null
    if (deepEqualJson(prev, next)) continue
    if (!(f in original)) original[f] = prev
    setField(paper, f, values[f])
    if (deepEqualJson(original[f], f === 'authors' ? (next ?? []) : next)) delete original[f]
  }
  if (Object.keys(original).length > 0) paper.extra.metadataOriginal = original
  else delete paper.extra.metadataOriginal
}

function setSeat(paper: Paper, seat: string, key: keyof SeatMetadata, values: MetadataValues): void {
  const all = { ...paper.reviewMetadata }
  const entry: SeatMetadata = { ...all[seat] }
  if (Object.keys(values).length > 0) entry[key] = values
  else delete entry[key]
  if (entry.overrides || entry.ignored) all[seat] = entry
  else delete all[seat]
  if (Object.keys(all).length > 0) paper.reviewMetadata = all
  else delete paper.reviewMetadata
}

// [impl->req~dat-440~1]
// [impl->req~dat-460~1]
/** Keeps only the fields that differ from the project value; an empty value means no override. */
export function applySeatEdit(paper: Paper, seat: string, values: MetadataValues): void {
  const overrides: MetadataValues = { ...paper.reviewMetadata?.[seat]?.overrides }
  for (const f of METADATA_FIELDS) {
    if (!(f in values)) continue
    const next = values[f]
    const empty = next === undefined || emptyTitle(f, next) || (Array.isArray(next) && next.length === 0)
    if (empty || deepEqualJson(next, paper[f] ?? null)) delete overrides[f]
    else (overrides as Record<string, unknown>)[f] = next
  }
  setSeat(paper, seat, 'overrides', overrides)
}

/** Remembers ignored proposal values in the seat file. */
export function recordIgnored(paper: Paper, seat: string, values: MetadataValues): void {
  setSeat(paper, seat, 'ignored', { ...paper.reviewMetadata?.[seat]?.ignored, ...values })
}

// [impl->req~dat-430~1]
// [impl->req~dat-460~1]
// [impl->req~lst-80~1]
/** The seat file that holds this seat's corrections: seat 1 with one reviewer, null when the seat may not correct. */
export function metadataSeatKey(project: MetadataProject, seat: string | null): string | null {
  if ((project.metadataEdit ?? 'off') === 'off') return null
  if (project.reviewers <= 1) return '1'
  if (seat === null || seat === 'consolidation' || seat === aiSeatId(project)) return null
  return seat
}

// [impl->req~dat-450~1]
// [impl->req~con-530~1]
/** True when this seat may write agreed corrections into the project file: Consolidation, or the only reviewer. */
export function canUpdateProject(project: MetadataProject, seat: string | null): boolean {
  if ((project.metadataEdit ?? 'off') === 'off') return false
  return project.reviewers <= 1 || seat === 'consolidation'
}

/** The human seats whose overrides Consolidation reconciles. */
export function humanSeats(project: MetadataProject): string[] {
  const ai = aiSeatId(project)
  const out: string[] = []
  for (let k = 1; k <= project.reviewers; k++) if (String(k) !== ai) out.push(String(k))
  return out
}

export interface FieldMerge {
  field: MetadataField
  original: unknown
  /** Each seat's value; the project value for a seat without an override. */
  seats: Record<string, unknown>
  agreed: boolean
}

// [impl->req~con-530~1]
/** Only fields some seat overrode. Agreed only when every seat set the same value. */
export function mergeSeatMetadata(paper: Paper, seats: string[]): FieldMerge[] {
  const out: FieldMerge[] = []
  for (const field of METADATA_FIELDS) {
    const original = paper[field] ?? null
    const changed = seats.filter((s) => {
      const o = paper.reviewMetadata?.[s]?.overrides
      return !!o && field in o && !deepEqualJson(o[field], original)
    })
    if (changed.length === 0) continue
    const values: Record<string, unknown> = {}
    for (const s of seats) {
      const o = paper.reviewMetadata?.[s]?.overrides
      values[s] = o && field in o ? o[field] : original
    }
    const list = Object.values(values)
    out.push({ field, original, seats: values, agreed: list.every((v) => deepEqualJson(v, list[0])) })
  }
  return out
}

// [impl->req~con-530~1]
/** Changes whenever a seat changes its overrides; stored as `extra.metadataSync` on Accept or Ignore. */
export function metadataFingerprint(paper: Paper, seats: string[]): string {
  return JSON.stringify(seats.map((s) => [s, paper.reviewMetadata?.[s]?.overrides ?? null]))
}

export function consolidationPending(paper: Paper, seats: string[]): boolean {
  return mergeSeatMetadata(paper, seats).length > 0 && paper.extra.metadataSync !== metadataFingerprint(paper, seats)
}
