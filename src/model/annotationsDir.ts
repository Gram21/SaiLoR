import { paperIdKey, paperIdProblem } from './paperId'

/**
 * Where a project keeps its annotation files: always one folder directly inside
 * the project file's own directory, named by the project file's
 * `annotationsDir` (default `annotations`).
 *
 * The value is a folder *name*, never a path. A project file can arrive by zip,
 * USB or shared drive, so a value that could reach anywhere else — a parent
 * directory, another folder, an absolute path — would let opening a project
 * read or write files outside it. Such a value is refused here and the default
 * used instead; the main process checks the resolved folder again before it
 * touches the disk.
 */

export const DEFAULT_ANNOTATIONS_DIR = 'annotations'

/** Why `name` cannot be an annotations folder, or `null` when it can. */
export function annotationsDirProblem(name: string): string | null {
  if (name !== name.trim()) return 'it starts or ends with a space'
  // Everything a paper id may not be: separators, `.`/`..`, `:` (drive
  // letters, and so `C:x`), control characters, a trailing dot, reserved
  // Windows names.
  const issue = paperIdProblem(name)
  if (issue) return issue.detail
  // `.git` would be git's own directory; any hidden name is too easy to lose.
  if (name.startsWith('.')) return 'it starts with a dot'
  return null
}

/** The annotations folder a parsed project file names, or the default when it
 *  names none or one that is not allowed. */
export function annotationsDirOf(raw: unknown): string {
  const name = (raw as { annotationsDir?: unknown } | null)?.annotationsDir
  return typeof name === 'string' && annotationsDirProblem(name) === null ? name : DEFAULT_ANNOTATIONS_DIR
}

/** A folder name for `projectFileName`'s own annotations: `review.json` →
 *  `review-annotations`, and `review-annotation.json` too rather than
 *  `review-annotation-annotations`. */
export function defaultSplitDirName(projectFileName: string): string {
  const stem = projectFileName.replace(/\.json$/i, '').replace(/-annotations?$/i, '')
  const name = `${stem}-annotations`
  return annotationsDirProblem(name) === null ? name : 'project-annotations'
}

/**
 * Would a project with these paper ids, of this kind (`screening`), write the
 * same files as the parsed project file `raw` if the two shared a folder?
 * Every file is named after its paper and, since screening projects name their
 * highlight files apart too, after the kind of project — so only a project of
 * the same kind that lists one of the same papers. A screening project and an
 * annotation project, even over the same papers, can share a folder. Ids are
 * compared the way a case-insensitive disk would (see `paperIdKey`).
 */
export function filesCollide(paperIds: Iterable<string>, screening: boolean, raw: unknown): boolean {
  if (Boolean((raw as { config?: { screening?: unknown } } | null)?.config?.screening) !== screening) return false
  return sharesPaper(paperIds, raw)
}

/** Does the parsed project file `raw` list one of `paperIds`? */
export function sharesPaper(paperIds: Iterable<string>, raw: unknown): boolean {
  const mine = new Set([...paperIds].map(paperIdKey))
  const papers = (raw as { papers?: unknown } | null)?.papers
  return (
    Array.isArray(papers) &&
    papers.some((p) => {
      const id = (p as { id?: unknown } | null)?.id
      return typeof id === 'string' && mine.has(paperIdKey(id))
    })
  )
}
