/**
 * Is this string safe to use as a path *relative to a repository root*?
 *
 * Lives here rather than in `electron/main.ts` for the same reason `url.ts`
 * does: it is a security gate on input that reaches a file write, so it is
 * written once, imported by the main process, and — unlike anything inside
 * `electron/` — reachable by the test suite.
 *
 * This is a check on the string alone. It cannot see the filesystem, so it says
 * nothing about symlinks; `assertInsideRoot` in the main process resolves the
 * real destination and is the other half of the guard.
 */

/** Reasons a relative path is refused, for the caller's error message. */
export type RelPathProblem = 'empty' | 'absolute' | 'traversal' | 'control-char' | 'dot-git'

/** `null` when `p` is acceptable, otherwise why it is not. */
export function relPathProblem(p: string): RelPathProblem | null {
  if (!p) return 'empty'
  // Control characters first: a newline in a path is never legitimate here and
  // would also corrupt any NUL-delimited git output the path is spliced into.
  if (/[\0\r\n]/.test(p)) return 'control-char'
  // Windows absolute forms, checked explicitly because `path.isAbsolute` on
  // POSIX does not recognise them: a drive letter (`C:\x`, `C:/x`) and a UNC
  // or root-relative path beginning with a separator.
  if (/^[a-zA-Z]:/.test(p) || /^[\\/]/.test(p)) return 'absolute'

  // Split on BOTH separators. On POSIX `p.split('/')` left
  // `..\..\Users\victim\.bashrc` as a single opaque segment, which passed —
  // while `path.win32.join` honours the backslashes and walks straight out of
  // the repository.
  const segments = p.split(/[\\/]/)
  if (segments.includes('..')) return 'traversal'

  // `.git` is a perfectly valid relative path that is never project data, and
  // writing into it — `config`, `hooks/pre-commit` — is a code-execution
  // primitive. Trailing dots and spaces are stripped before comparing because
  // Win32 strips them from path components itself, so `.git.\config` and
  // ` .git/config` both open `.git` while a literal comparison sees two names
  // that are not `.git` and lets them through.
  if (segments.some((seg) => seg.trim().toLowerCase().replace(/[. ]+$/, '') === '.git')) {
    return 'dot-git'
  }
  return null
}

/** The project's `annotations/` folder, git-style (forward slashes,
 *  repo-root-relative) — derived from the project file's own `relPath` so
 *  the derivation has one implementation, shared by the main process (which
 *  reads/writes it) and the renderer (which only needs to recognise it in a
 *  `git status` listing). */
export function annotationsRelDir(relPath: string): string {
  const dir = relPath.split(/[\\/]/).slice(0, -1).join('/')
  return dir === '' ? 'annotations' : `${dir}/annotations`
}

/**
 * Of a parsed `git status`, the paths that must not be left lying around when
 * a merge starts: every tracked modification, plus untracked files sitting
 * inside the project's own `annotations/` folder.
 *
 * Untracked files used to be waved through wholesale, on the reasoning that
 * git never touches them. It does once a merge commit is recorded: the merge
 * stages the folder and an untracked annotation file goes in with it, credited
 * to whoever ran Pull and never shown in the merge review. Untracked files
 * *elsewhere* in the repository — scratch notes, a PDF nobody has added yet —
 * still block nothing, because a guard that fires on those is one reviewers
 * learn to work around.
 */
export function mergeBlockingPaths(
  changes: { path: string; code: string }[],
  annotationsDir: string,
): string[] {
  return changes
    .filter((c) => c.code !== '??' || c.path.startsWith(`${annotationsDir}/`))
    .map((c) => c.path)
}
