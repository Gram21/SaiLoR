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
 * Can a project with these paper ids write the same files as the parsed
 * project file `raw`, were the two to share a folder? Only through a paper both
 * list: every file is named after its paper. (Same-kind projects then write
 * the very same answer files; a screening and an annotation project still both
 * write `marks-*.json`.) Two projects with no paper in common — a screening
 * project and the annotation project imported from it, whose clashing ids the
 * import renames — can share a folder safely. Compared the way a
 * case-insensitive disk would (see `paperIdKey`).
 */
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
