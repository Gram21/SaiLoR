/**
 * Shapes shared between the Electron main process's git plumbing and the
 * renderer's `GitPlatform` seam. Nothing here talks to git or the DOM — see
 * `src/git/merge.ts` for the same rule applied to the merge itself.
 */

import type { ProjectFileEntry } from '../model/project'

/** The split-file form of a project (`splitProjectFiles`'s output) — what a
 *  git write actually puts on disk: `project.json` plus a reconciled
 *  `annotations/` folder. Passed across the IPC boundary instead of one
 *  whole-project text, since committing/reverting now spans many files. */
export interface SplitProject {
  metaText: string
  files: ProjectFileEntry[]
}

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

/** One local branch, from `git branch --format`. */
export interface GitBranch {
  name: string
  /** True for the branch HEAD currently points at. */
  current: boolean
}

/**
 * The outcome of asking to switch to another branch — mirrors `PullStart`'s
 * shape for the same reason: one discriminated result the renderer branches
 * on, computed entirely before anything is mutated except where `'merge'`
 * says otherwise (see `beginBranchSwitch`'s own doc comment for exactly what
 * that case has already done by the time it's returned).
 */
export type BranchSwitchStart =
  /** Nothing in the project is uncommitted — a plain `checkoutBranch` suffices. */
  | { kind: 'no-changes' }
  /** Something *outside* the project's own files is also dirty — SaiLoR only
   *  knows how to carry the project's own uncommitted changes across a
   *  branch switch, not arbitrary repo files. Nothing has been touched. */
  | { kind: 'other-files-dirty'; paths: string[] }
  | { kind: 'error'; message: string }
  | {
      kind: 'merge'
      /** The branch switched *from* — `abortBranchSwitch` checks back out to
       *  this if the reviewer cancels conflict resolution. */
      sourceBranch: string
      /** The project's content at the commit being switched away from, or
       *  `null` when it did not exist there. */
      base: string | null
      /** The project's content including the reviewer's uncommitted edits,
       *  captured before anything was touched. */
      ours: string
      /** The target branch's committed content. */
      theirs: string
    }

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
  finishPull(root: string, relPath: string, working: SplitProject): Promise<GitRun>
  abortPull(root: string): Promise<GitRun>
  /** HEAD's copy of the project — `relPath` (`project.json`) plus its
   *  `annotations/` folder, reassembled into one logical text — for the
   *  commit panel's field-level review (`src/git/changes.ts`). `null` when
   *  there is no HEAD revision of `relPath` at all (a newly added, still-
   *  untracked project). */
  headContent(root: string, relPath: string): Promise<string | null>
  /** The working tree's own content, reassembled directly from disk (not
   *  through the app's in-memory, possibly-unsaved `project`) — the other
   *  half of what `changes.ts` diffs. `null` when it is missing or unreadable. */
  workingContent(root: string, relPath: string): Promise<string | null>
  /**
   * Commits `committed` (split into `project.json` + `annotations/` files)
   * as the project's content, plus whatever is already on disk at
   * `otherPaths`, then writes `working` back afterward regardless of whether
   * the commit succeeded — see `electron/main.ts`'s `git:commitPartial`
   * handler for why the two can differ and why the write-back is
   * unconditional.
   */
  commitPartial(
    root: string,
    relPath: string,
    committed: SplitProject,
    working: SplitProject,
    otherPaths: string[],
    message: string,
  ): Promise<GitRun>
  /** Writes `working` to the project — the state the reviewer's field-level
   *  "discard" choices compose to (`composeContents`'s `workingOut`, split)
   *  — without staging or committing. The write-counterpart to
   *  `workingContent`, for reverting local edits without a commit. */
  writeWorking(root: string, relPath: string, working: SplitProject): Promise<GitRun>

  /** Local branches, current one first — for the branch switcher. */
  branches(root: string): Promise<GitBranch[]>
  /** Creates `name` at the current `HEAD`, without switching to it — the
   *  caller always follows this with the ordinary switch flow. */
  createBranch(root: string, name: string): Promise<GitRun>
  /** A plain, no-local-changes checkout — only safe to call after
   *  `beginBranchSwitch` returned `'no-changes'`, or outside a project's
   *  repository entirely. */
  checkoutBranch(root: string, branch: string): Promise<GitRun>
  /**
   * Checks whether switching to `branch` is safe, and if the project has
   * uncommitted changes that can be carried over, does the actual switch
   * (stash, checkout, read the three revisions) — see
   * `electron/main.ts`'s handler for exactly what "safe" means and why the
   * mutation already happened by the time this returns `'merge'`.
   */
  beginBranchSwitch(root: string, relPath: string, branch: string): Promise<BranchSwitchStart>
  /** Writes the resolved project onto the now-checked-out target branch and
   *  drops the stash `beginBranchSwitch` created — the branch-switch
   *  counterpart to `finishPull`. */
  finishBranchSwitch(root: string, relPath: string, resolved: SplitProject): Promise<GitRun>
  /** Checks back out to `sourceBranch` and restores the stashed changes —
   *  the branch-switch counterpart to `abortPull`. Unlike `abortPull` (which
   *  aborts an in-progress git merge with nothing else to undo), this must
   *  reverse an already-completed checkout, which is why it needs to be told
   *  which branch to return to. */
  abortBranchSwitch(root: string, sourceBranch: string): Promise<GitRun>
}
