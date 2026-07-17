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

/** The reviewer's own `git config` identity in one repository — the raw IPC
 *  shape, both fields always strings. An empty `email` means this machine has
 *  no git identity here (no `user.email` set, at any config level git
 *  reads); the caller declines to guess who that might be rather than treat
 *  it as an error. See `src/model/identity.ts`'s `ReviewerIdentity` for the
 *  validated, non-empty-by-construction shape this becomes once it's checked. */
export interface GitIdentity {
  email: string
  name: string
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
  /** `user.email`/`user.name` as configured for `root` — empty strings mean
   *  "unset here". See `GitIdentity`. */
  identity(root: string): Promise<GitIdentity>
  status(root: string): Promise<GitStatus>
  commit(root: string, paths: string[], message: string): Promise<GitRun>
  push(root: string): Promise<GitRun>
  beginPull(root: string, relPath: string): Promise<PullStart>
  finishPull(root: string, relPath: string, text: string): Promise<GitRun>
  abortPull(root: string): Promise<GitRun>
  /** HEAD's copy of `relPath`, for the commit panel's field-level review
   *  (`src/git/changes.ts`). `null` when there is no HEAD revision of it at
   *  all (a newly added, still-untracked file). */
  headContent(root: string, relPath: string): Promise<string | null>
  /** The working-tree file's own content, read directly (not through the
   *  app's in-memory, possibly-unsaved `project`) — the other half of what
   *  `changes.ts` diffs. `null` when it is missing or unreadable. */
  workingContent(root: string, relPath: string): Promise<string | null>
  /**
   * Commits `committedText` as `relPath`'s content, plus whatever is already
   * on disk at `otherPaths`, then writes `workingText` to `relPath`
   * afterward regardless of whether the commit succeeded — see
   * `electron/main.ts`'s `git:commitPartial` handler for why the two texts
   * can differ and why the write-back is unconditional.
   */
  commitPartial(
    root: string,
    relPath: string,
    committedText: string,
    workingText: string,
    otherPaths: string[],
    message: string,
  ): Promise<GitRun>
  /** Writes `text` to the working-tree file at `relPath` — the content the
   *  reviewer's field-level "discard" choices compose to (`composeContents`'s
   *  `workingOut`) — without staging or committing. The write-counterpart to
   *  `workingContent`, for reverting local edits without a commit. */
  writeWorking(root: string, relPath: string, text: string): Promise<GitRun>
}
