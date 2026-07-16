/**
 * Shapes shared between the Electron main process's git plumbing and the
 * renderer's `GitPlatform` seam. Nothing here talks to git or the DOM — see
 * `src/git/merge.ts` for the same rule applied to the merge itself.
 */

/** The outcome of one `git` invocation. A non-zero exit is data, not an
 *  exception — see `runGit`'s doc comment in electron/main.ts. */
export interface GitRun {
  ok: boolean
  /** Exit code; `null` when git itself never started (missing binary, timeout). */
  code: number | null
  stdout: string
  stderr: string
}

export interface GitProbe {
  available: boolean
  /** `git --version`'s own text, e.g. "git version 2.43.0". */
  version: string
  /** Empty when `available` is true. */
  error: string
}

/** One line of `git status --porcelain=v1 -z`, parsed. */
export interface GitFileChange {
  /** Repo-relative path (the new path, for a rename). */
  path: string
  /** The two-letter status code, e.g. "M ", "??", "R ". */
  code: string
  /** True for an unresolved merge conflict (see `parsePorcelain`'s rule). */
  unmerged: boolean
  /** The path this one was renamed/copied from, when the record says so. */
  from?: string
}

export interface GitStatus {
  changes: GitFileChange[]
  /** `git diff HEAD --` of the whole tree, capped by `capDiff`. */
  diff: string
  diffTruncated: boolean
}

export interface GitRepoInfo {
  /** Absolute, realpath'd — from `git rev-parse --show-toplevel`. */
  root: string
  /** The project file's path relative to `root`, from `--show-prefix` + the file name. */
  relPath: string
  /** `null` for a detached HEAD. */
  branch: string | null
  /** `"origin/main"` form, or `null` when the branch has no upstream. */
  upstream: string | null
  hasHead: boolean
}

export type CloneOutcome = { ok: true; dest: string } | { ok: false; error: string }

export type PullStart =
  | { kind: 'up-to-date' }
  | { kind: 'fast-forwarded' }
  | { kind: 'dirty'; paths: string[] }
  | { kind: 'no-upstream'; branch: string | null }
  | { kind: 'conflict-elsewhere'; paths: string[] }
  | { kind: 'error'; message: string }
  | {
      kind: 'merge'
      /** The upstream ref that was merged, e.g. "origin/main" — shown to the reviewer. */
      ref: string
      /** The project file's text at the merge base, or `null` when it did not exist there
       *  (added independently on both sides). */
      base: string | null
      ours: string
      theirs: string
    }

/**
 * Git operations against **the user's own git installation**. See
 * `PlatformAdapter.getGit()`'s doc comment for why this exists only in
 * Electron and what `null` there means.
 */
export interface GitPlatform {
  probe(): Promise<GitProbe>
  pickCloneDir(): Promise<string | null>
  clone(url: string, dest: string): Promise<CloneOutcome>
  /** The project-file picker, opened **inside** `dir`. Returns the chosen absolute
   *  path — the caller opens it through the ordinary project-open path, so nothing
   *  about opening a project exists twice. */
  pickProjectIn(dir: string): Promise<string | null>
  info(projectPath: string): Promise<GitRepoInfo | null>
  status(root: string): Promise<GitStatus>
  commit(root: string, paths: string[], message: string): Promise<GitRun>
  push(root: string): Promise<GitRun>
  beginPull(root: string, relPath: string): Promise<PullStart>
  finishPull(root: string, relPath: string, text: string): Promise<GitRun>
  abortPull(root: string): Promise<GitRun>
}
