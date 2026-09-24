import { loadProject } from './project'
import type { ResolvedDef } from './schema'
import { ancestorsOf, parseSchemaHistory, parseSchemaVersion } from './schemaVersion'
import { parsePath } from '../llm/paths'

/**
 * Splitting an annotations folder that several project files next to each
 * other share (see `model/annotationsDir.ts`) into one folder per project.
 *
 * `planSplit` works out which files belong to which project; `applySplit`
 * carries the plan out through injected file operations, so the order that
 * keeps it safe is testable without a disk.
 */

export interface SplitProject {
  /** Absolute path of the project file. */
  path: string
  /** Its file name, for display. */
  name: string
  /** The project file, parsed. */
  meta: unknown
}

export interface SplitFile {
  /** Relative to the shared folder: `<paperId>/<file>.json`. */
  relPath: string
  text: string
}

export interface SplitRow {
  relPath: string
  /** Projects this file could belong to by paper id and file kind. */
  candidates: string[]
  /** Where it goes: one project, several (copied to each), or none (left where it is). */
  targets: string[]
  /** Why, in words — shown for the rows the reviewer should look at. */
  reason: string
  /** More than one project could own it, so the reviewer should confirm. */
  ambiguous: boolean
}

const SCREENING_FILE = /^screening-(\d+|consolidated)\.json$/
const REVIEW_FILE = /^(reviewer-\d+|consolidated)\.json$/
const MARKS_FILE = /^marks-(\d+|consolidated)\.json$/

interface Known {
  path: string
  ids: Set<string>
  screening: boolean
  versions: Set<string>
  schema: ResolvedDef[]
}

function known(p: SplitProject): Known {
  const meta = (p.meta ?? {}) as { papers?: unknown[]; config?: { screening?: unknown }; schemaVersion?: unknown; schemaHistory?: unknown }
  const ids = new Set(
    (Array.isArray(meta.papers) ? meta.papers : [])
      .map((x) => (x as { id?: unknown } | null)?.id)
      .filter((id): id is string => typeof id === 'string'),
  )
  const history = parseSchemaHistory(meta.schemaHistory)
  const current = parseSchemaVersion(meta.schemaVersion)
  const versions = current ? ancestorsOf(history, current) : new Set<string>()
  for (const e of history) {
    versions.add(e.id)
    for (const a of e.absorbed ?? []) versions.add(a.id)
  }
  let schema: ResolvedDef[] = []
  try {
    schema = loadProject(p.meta).schema
  } catch {
    // An unloadable sibling just cannot win on schema fit.
  }
  return { path: p.path, ids, screening: Boolean(meta.config?.screening), versions, schema }
}

/** How many of `tree`'s recorded answers sit under names `defs` describes. */
function fit(defs: ResolvedDef[], tree: unknown): number {
  if (typeof tree !== 'object' || tree === null) return 0
  let n = 0
  for (const [name, instances] of Object.entries(tree as Record<string, unknown>)) {
    const def = defs.find((d) => d.name === name)
    if (!def || !Array.isArray(instances)) continue
    for (const inst of instances as { value?: unknown; children?: unknown }[]) {
      if (inst?.value !== undefined && inst.value !== null && inst.value !== '') n++
      n += fit(def.children, inst?.children)
    }
  }
  return n
}

/** How many of a marks file's field links name a field `defs` describes. */
function linkFit(defs: ResolvedDef[], marks: unknown): number {
  if (!Array.isArray(marks)) return 0
  let n = 0
  for (const m of marks as { linkedFields?: { path?: unknown }[] }[]) {
    for (const l of m?.linkedFields ?? []) {
      const segs = typeof l?.path === 'string' ? parsePath(l.path) : null
      let level = defs
      let ok = !!segs
      for (const s of segs ?? []) {
        const def = level.find((d) => d.name === s.name)
        if (!def) {
          ok = false
          break
        }
        level = def.children
      }
      if (ok) n++
    }
  }
  return n
}

/**
 * Which project each file in the shared folder belongs to.
 *
 * By paper id and file kind first: a screening project owns `screening-*`
 * files, an annotation project `reviewer-*`/`consolidated`, either may own
 * `marks-*`. Where that leaves more than one project — the same paper in two
 * projects of the same kind — the schema version the file was written under
 * decides, then which project's schema describes more of its answers; a tie is
 * copied to each, since losing a file is worse than a duplicate.
 */
export function planSplit(projects: SplitProject[], files: SplitFile[]): SplitRow[] {
  const all = projects.map(known)
  return files.map((f) => {
    const slash = f.relPath.lastIndexOf('/')
    const id = f.relPath.slice(0, slash)
    const name = f.relPath.slice(slash + 1)
    const kind = SCREENING_FILE.test(name) ? 'screening' : REVIEW_FILE.test(name) ? 'review' : MARKS_FILE.test(name) ? 'marks' : null
    const candidates = all
      .filter((p) => p.ids.has(id))
      .filter((p) => kind === 'marks' || (kind === 'screening' ? p.screening : kind === 'review' && !p.screening))
      .map((p) => p.path)
    const row = (targets: string[], reason: string): SplitRow => ({
      relPath: f.relPath,
      candidates,
      targets,
      reason,
      ambiguous: candidates.length > 1,
    })
    if (candidates.length === 0) return row([], 'No project here lists this paper for this kind of file.')
    if (candidates.length === 1) return row(candidates, 'Only this project lists this paper.')

    let parsed: { schemaVersion?: unknown; annotations?: unknown; marks?: unknown } = {}
    try {
      parsed = JSON.parse(f.text)
    } catch {
      return row(candidates, 'The file cannot be read, so it is copied to each.')
    }
    const pool = all.filter((p) => candidates.includes(p.path))
    const stamp = parseSchemaVersion(parsed.schemaVersion)
    const byStamp = stamp ? pool.filter((p) => p.versions.has(stamp)) : []
    if (byStamp.length === 1) return row([byStamp[0].path], "Written under this project's schema version.")

    const scores = pool.map((p) => ({ path: p.path, score: kind === 'marks' ? linkFit(p.schema, parsed.marks) : fit(p.schema, parsed.annotations) }))
    const best = Math.max(...scores.map((s) => s.score))
    const winners = scores.filter((s) => s.score === best)
    if (best > 0 && winners.length === 1) return row([winners[0].path], "Its answers fit this project's schema best.")
    return row(candidates, 'Nothing tells the projects apart, so it is copied to each.')
  })
}

/** What `applySplit` needs from the disk. Paths are relative to the project directory. */
export interface SplitFs {
  copy(from: string, to: string): Promise<void>
  readText(file: string): Promise<string>
  writeText(file: string, text: string): Promise<void>
  remove(file: string): Promise<void>
  /** Remove `dir` if it is empty; otherwise leave it. */
  removeDirIfEmpty(dir: string): Promise<void>
}

export interface SplitPlan {
  /** The folder being split, by name. */
  shared: string
  /** Each project's file name and its new folder. */
  projects: { file: string; folder: string }[]
  /** Each file (relative to `shared`) and the project files it goes to. */
  rows: { relPath: string; targets: string[] }[]
}

/**
 * Carry out a split. Copies first and deletes last, with the project files
 * pointed at their new folders in between: stopped at any point, every answer
 * is still in at least one place a project reads from.
 */
export async function applySplit(plan: SplitPlan, fs: SplitFs): Promise<void> {
  const folderOf = new Map(plan.projects.map((p) => [p.file, p.folder]))
  const moved = plan.rows.filter((r) => r.targets.length > 0)
  for (const r of moved) {
    for (const target of r.targets) {
      const folder = folderOf.get(target)
      if (!folder) throw new Error(`No folder chosen for "${target}".`)
      await fs.copy(`${plan.shared}/${r.relPath}`, `${folder}/${r.relPath}`)
    }
  }
  for (const p of plan.projects) {
    const raw = JSON.parse(await fs.readText(p.file)) as Record<string, unknown>
    await fs.writeText(p.file, JSON.stringify({ ...raw, annotationsDir: p.folder }, null, 2))
  }
  for (const r of moved) await fs.remove(`${plan.shared}/${r.relPath}`)
  const paperDirs = new Set(moved.map((r) => r.relPath.slice(0, r.relPath.lastIndexOf('/'))))
  for (const d of paperDirs) await fs.removeDirIfEmpty(`${plan.shared}/${d}`)
  await fs.removeDirIfEmpty(plan.shared)
}
