import type { Paper, Project } from './project'
import { t } from '../i18n'

export interface Person {
  id: string
  name: string
}

export interface Assignment {
  person: string
  seat: number
}

/**
 * Strict mode limits each person to the papers and seats assigned to them.
 * A workflow aid only: anyone can pick another person or edit the files.
 */
export interface StrictConfig {
  enabled: boolean
  persons: Person[]
  /** Keyed by paper id; entries sorted by seat. */
  assignments: Record<string, Assignment[]>
}

type StrictProject = Pick<Project, 'strict' | 'reviewers' | 'screening'>

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// [impl->req~edt-110~1]
// [impl->req~edt-120~1]
/**
 * Read `config.strict`, `config.persons` and `config.assignments`. Returns no
 * config when none of the keys is present, so an older project stays as it was.
 */
export function parseStrictConfig(
  config: unknown,
  paperIds: ReadonlySet<string>,
): { strict?: StrictConfig; problems: string[] } {
  const problems: string[] = []
  const c = isRecord(config) ? config : {}
  if (!('strict' in c) && !('persons' in c) && !('assignments' in c)) return { problems }

  if ('strict' in c && typeof c.strict !== 'boolean') problems.push(t('editor.strictProblem.strictType'))

  const persons: Person[] = []
  if ('persons' in c && !Array.isArray(c.persons)) problems.push(t('editor.strictProblem.personsType'))
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const [i, raw] of (Array.isArray(c.persons) ? c.persons : []).entries()) {
    const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id.trim() : ''
    const name = isRecord(raw) && typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!id || !name) {
      problems.push(t('editor.strictProblem.personEntry', { i }))
      continue
    }
    if (ids.has(id)) problems.push(t('editor.strictProblem.personIdTwice', { id }))
    if (names.has(name.toLowerCase())) problems.push(t('editor.strictProblem.personNameTwice', { name }))
    ids.add(id)
    names.add(name.toLowerCase())
    persons.push({ id, name })
  }

  const assignments: Record<string, Assignment[]> = {}
  if ('assignments' in c && !isRecord(c.assignments)) problems.push(t('editor.strictProblem.assignmentsType'))
  for (const [paperId, list] of Object.entries(isRecord(c.assignments) ? c.assignments : {})) {
    if (!Array.isArray(list)) {
      problems.push(t('editor.strictProblem.assignmentsList', { paperId }))
      continue
    }
    const entries: Assignment[] = []
    for (const raw of list) {
      const person = isRecord(raw) && typeof raw.person === 'string' ? raw.person : ''
      const seat = isRecord(raw) ? raw.seat : undefined
      if (!ids.has(person)) {
        problems.push(t('editor.strictProblem.unknownPerson', { paperId, person }))
        continue
      }
      if (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 1) {
        problems.push(t('editor.strictProblem.seatInvalid', { paperId }))
        continue
      }
      if (entries.some((e) => e.seat === seat)) problems.push(t('editor.strictProblem.seatTwice', { paperId, seat }))
      else if (entries.some((e) => e.person === person))
        problems.push(t('editor.strictProblem.personTwice', { paperId, person }))
      else entries.push({ person, seat })
    }
    if (paperIds.has(paperId) && entries.length > 0) assignments[paperId] = entries.sort((a, b) => a.seat - b.seat)
  }

  if (problems.length > 0) return { problems }
  return { strict: { enabled: c.strict === true, persons, assignments }, problems }
}

// [impl->req~edt-110~1]
/** The config keys for `strict`; each key only when it holds a value. */
export function strictConfigJson(strict: StrictConfig | undefined): Record<string, unknown> {
  if (!strict) return {}
  const papers = Object.keys(strict.assignments)
    .filter((id) => strict.assignments[id].length > 0)
    .sort()
  return {
    ...(strict.enabled ? { strict: true } : {}),
    ...(strict.persons.length > 0 ? { persons: strict.persons.map(({ id, name }) => ({ id, name })) } : {}),
    ...(papers.length > 0
      ? {
          assignments: Object.fromEntries(
            papers.map((id) => [
              id,
              [...strict.assignments[id]].sort((a, b) => a.seat - b.seat).map(({ person, seat }) => ({ person, seat })),
            ]),
          ),
        }
      : {}),
  }
}

/** Strict mode applies only to annotation projects with more than one reviewer. */
export function strictActive(project: StrictProject | null | undefined): project is StrictProject & { strict: StrictConfig } {
  return !!project?.strict?.enabled && project.reviewers > 1 && !project.screening && project.strict.persons.length > 0
}

/** A paper's assignments to seats that exist under the current reviewer count. */
export function liveAssignments(project: StrictProject, paperId: string): Assignment[] {
  return (project.strict?.assignments[paperId] ?? []).filter((a) => a.seat <= project.reviewers)
}

// [impl->req~con-470~1]
export function assignedSeat(project: StrictProject, paperId: string, personId: string): string | null {
  const a = liveAssignments(project, paperId).find((x) => x.person === personId)
  return a ? String(a.seat) : null
}

// [impl->req~con-460~1]
/** The ids of the papers assigned to a person, in project order. */
export function personPapers(project: StrictProject & Pick<Project, 'papers'>, personId: string): string[] {
  return project.papers.filter((p) => assignedSeat(project, p.id, personId) !== null).map((p) => p.id)
}

// [impl->req~con-500~1]
/** The assigned persons who have not finished their seat on this paper. */
export function missingFinishers(project: StrictProject, paper: Pick<Paper, 'id' | 'reviewsFinished'>): Person[] {
  const persons = project.strict?.persons ?? []
  return liveAssignments(project, paper.id)
    .filter((a) => paper.reviewsFinished[String(a.seat)] !== true)
    .map((a) => persons.find((p) => p.id === a.person))
    .filter((p): p is Person => p !== undefined)
}

// [impl->req~edt-160~1]
export function personCounts(
  strict: StrictConfig,
  reviewers: number,
  isFinished: (paperKey: string, seat: number) => boolean,
): Record<string, { assigned: number; finished: number }> {
  const counts = Object.fromEntries(strict.persons.map((p) => [p.id, { assigned: 0, finished: 0 }]))
  for (const [key, list] of Object.entries(strict.assignments)) {
    for (const a of list) {
      if (a.seat > reviewers || !counts[a.person]) continue
      counts[a.person].assigned++
      if (isFinished(key, a.seat)) counts[a.person].finished++
    }
  }
  return counts
}

// [impl->req~edt-150~1]
/**
 * Give every paper without an assignment `perPaper` persons, in turn over the
 * persons (round robin), on the given seats in order.
 */
export function bulkAssign(
  persons: Person[],
  paperKeys: string[],
  existing: Record<string, Assignment[]>,
  perPaper: number,
  seats: number[],
): Record<string, Assignment[]> {
  const n = Math.min(perPaper, persons.length, seats.length)
  const out = { ...existing }
  if (n < 1) return out
  let next = 0
  for (const key of paperKeys) {
    if ((out[key] ?? []).length > 0) continue
    out[key] = seats.slice(0, n).map((seat, i) => ({ person: persons[(next + i) % persons.length].id, seat }))
    next = (next + n) % persons.length
  }
  return out
}
