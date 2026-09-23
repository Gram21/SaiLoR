import { assembleLegacyProjectJson, loadProject, splitProjectFiles, type Project } from './project'

/**
 * What a save does when files it would overwrite changed on disk since the
 * project was last read or written (`StaleSaveError`): keep the reviewer's own
 * version of those files, or the one on disk. Worked out file by file, the
 * unit the clash is detected in, so every other file comes out the same either
 * way — the reviewer's edits where they made some, the disk's everywhere else.
 */

/** Stand-in path for `project.json` itself, next to the `annotations/`-relative ones. */
const META = ''

type FileSet = Map<string, string>

function filesOf(project: Project): FileSet {
  const { meta, files } = splitProjectFiles(project)
  const out: FileSet = new Map([[META, JSON.stringify(meta)]])
  for (const f of files) if (f.text !== null) out.set(f.relPath, f.text)
  return out
}

/** A clash as `project:save` names it (`annotations/p1/reviewer-2.json`, or
 *  the project file's own name) in `filesOf`'s terms. */
function clashKey(path: string): string {
  return path.startsWith('annotations/') ? path.slice('annotations/'.length) : META
}

const REVIEWER_FILE = /^(?:reviewer|screening)-(\d+)\.json$/
const MARKS_FILE = /^marks-(\d+)\.json$/

/** The reverse of `splitProjectFiles`, parsed the way opening the project from disk would. */
function projectOf(files: FileSet): Project {
  const papers = new Map<
    string,
    { consolidated?: unknown; reviewers: Map<string, unknown>; marksConsolidated?: unknown; reviewMarks: Map<string, unknown> }
  >()
  for (const [relPath, text] of files) {
    if (relPath === META) continue
    const slash = relPath.lastIndexOf('/')
    const id = relPath.slice(0, slash)
    const name = relPath.slice(slash + 1)
    let entry = papers.get(id)
    if (!entry) {
      entry = { reviewers: new Map(), reviewMarks: new Map() }
      papers.set(id, entry)
    }
    const value: unknown = JSON.parse(text)
    const reviewer = REVIEWER_FILE.exec(name)
    const marks = MARKS_FILE.exec(name)
    if (reviewer) entry.reviewers.set(reviewer[1], value)
    else if (marks) entry.reviewMarks.set(marks[1], value)
    else if (name === 'marks-consolidated.json') entry.marksConsolidated = value
    else entry.consolidated = value
  }
  return loadProject(JSON.stringify(assembleLegacyProjectJson(JSON.parse(files.get(META)!), papers)))
}

/**
 * The project to save after a clash. `base` is the project as last read or
 * written, `mine` the reviewer's unsaved one, `disk` what is there now.
 * `keep: 'mine'` overwrites the clashing files with the reviewer's version;
 * `keep: 'disk'` drops the reviewer's edits to those files only. A file the
 * reviewer did not change always comes from disk, so nobody's work in it is
 * rolled back.
 */
export function resolveClash(
  base: Project | null,
  mine: Project,
  disk: Project,
  clashes: string[],
  keep: 'mine' | 'disk',
): Project {
  const baseFiles = base ? filesOf(base) : new Map<string, string>()
  const mineFiles = filesOf(mine)
  const diskFiles = filesOf(disk)
  const clashing = new Set(clashes.map(clashKey))
  const out: FileSet = new Map()
  for (const path of new Set([...mineFiles.keys(), ...diskFiles.keys(), ...baseFiles.keys()])) {
    const edited = mineFiles.get(path) !== baseFiles.get(path)
    const takeMine = edited && !(keep === 'disk' && clashing.has(path))
    const text = takeMine ? mineFiles.get(path) : diskFiles.get(path)
    if (text !== undefined) out.set(path, text)
  }
  return projectOf(out)
}
