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

/** One branch, from `git for-each-ref` over `refs/heads` and `refs/remotes`. */
export interface GitBranch {
  name: string
  /** True for the branch HEAD currently points at. Never true for a remote one. */
  current: boolean
  /** True for a remote-tracking ref ("origin/main"). Those can be *merged* but
   *  never *switched to* — checking one out would detach HEAD — so the branch
   *  switcher filters them out and only the merge picker offers them. They are
   *  also only as fresh as the last fetch; `beginMerge` is what fetches. */
  remote: boolean
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

/**
 * The outcome of starting a merge of some ref into the current branch. A pull
 * *is* one of these — "merge `@{u}`" — which is why `PullStart` below is this
 * union plus the one case only a pull can hit. Both are produced by the same
 * `beginMergeInto` in the main process, so the renderer handles the shared
 * cases in exactly one place (`applyMergeStart` in `gitStore.ts`).
 */
export type MergeStart =
  | { kind: 'up-to-date' }
  | { kind: 'fast-forwarded' }
  | { kind: 'dirty'; paths: string[] }
  | { kind: 'conflict-elsewhere'; paths: string[] }
  | { kind: 'error'; message: string }
  | {
      kind: 'merge'
      /** The ref that was merged — "origin/main" for a pull, a branch name for
       *  an explicit merge. Shown to the reviewer. */
      ref: string
      /** The project file's text at the merge base, or `null` when it did not exist there
       *  (added independently on both sides). */
      base: string | null
      ours: string
      theirs: string
    }

export type PullStart = MergeStart | { kind: 'no-upstream'; branch: string | null }

/** One entry from `git log`, for the history panel — see `parseGitLog` in
 *  `src/git/output.ts` for how the `date` string (ISO 8601) is produced. */
export interface CommitRecord {
  hash: string
  date: string
  subject: string
}

export interface LogBeginResult {
  commits: CommitRecord[]
  /** True when the log was cut off at the cap (`electron/main.ts`'s
   *  `LOG_MAX_COMMITS`) rather than genuinely ending there. */
  truncated: boolean
  error: string | null
}

/**
 * The raw material for a commit-history row's field-level diff: the
 * project's text at the commit itself and at its first parent. Deliberately
 * text, not a parsed `Project` or a `DetectedChanges` — `loadProject`/
 * `detectFieldChanges` are renderer-side (called from `gitStore.ts`, the same
 * as `refreshFieldReview`'s `head`/`working` pair), so this process only ever
 * fetches, never parses or diffs.
 */
export type LogRevisionFetch =
  | { kind: 'initial' } // no parent — the first commit to touch this file
  | { kind: 'error'; message: string }
  | { kind: 'texts'; head: string; parent: string }

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
  /** `amend` folds this commit into HEAD (`git commit --amend`) instead of
   *  creating a new one — for fixing up a just-made commit's message or
   *  contents before it's shared. */
  commit(root: string, paths: string[], message: string, amend: boolean): Promise<GitRun>
  /** HEAD's own commit message (`%B`, trailing newline stripped) — used to
   *  prefill the commit-message field when the reviewer switches to amend.
   *  `null` when there is no HEAD commit yet. */
  lastCommitMessage(root: string): Promise<string | null>
  push(root: string): Promise<GitRun>
  beginPull(root: string, relPath: string): Promise<PullStart>
  /**
   * Merges `ref` — a local branch or a remote-tracking one — into the current
   * branch. The same operation `beginPull` performs against `@{u}`, minus the
   * upstream lookup, so it is finished and aborted with `finishPull` /
   * `abortPull` rather than a pair of its own. Fetches first when `ref` is
   * remote-tracking, so the merge is against current data.
   */
  beginMerge(root: string, relPath: string, ref: string): Promise<MergeStart>
  /** `git log`, scoped to `relPath` and its `annotations/` dir — for the
   *  commit-history panel. Capped, not paginated; `truncated` says so. */
  logBegin(root: string, relPath: string): Promise<LogBeginResult>
  /** The two revisions a history row's diff needs, fetched but not parsed —
   *  see `LogRevisionFetch`'s own doc comment for why. */
  logDiff(root: string, relPath: string, rev: string): Promise<LogRevisionFetch>
  /** Writes the resolved project, stages it and records the merge commit —
   *  for a pull and for `beginMerge` alike (both leave the repository
   *  mid-merge with `MERGE_HEAD` set, which is all this needs). */
  finishPull(root: string, relPath: string, working: SplitProject): Promise<GitRun>
  /** `git merge --abort` — undoes whichever of `beginPull`/`beginMerge` is in
   *  flight, leaving the work tree exactly as it was. */
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
    amend: boolean,
  ): Promise<GitRun>
  /** Writes `working` to the project — the state the reviewer's field-level
   *  "discard" choices compose to (`composeContents`'s `workingOut`, split)
   *  — without staging or committing. The write-counterpart to
   *  `workingContent`, for reverting local edits without a commit. */
  writeWorking(root: string, relPath: string, working: SplitProject): Promise<GitRun>

  /** Local branches and remote-tracking ones — the switcher takes the locals,
   *  the merge picker takes both (see `GitBranch.remote`). */
  branches(root: string): Promise<GitBranch[]>
  /** Creates `name` at the current `HEAD`, without switching to it — the
   *  caller always follows this with the ordinary switch flow. */
  createBranch(root: string, name: string): Promise<GitRun>
  /** `git branch -d` — refuses (via `ok: false`) when `branch` isn't fully
   *  merged into the current one. No force option. Local branches only. */
  deleteBranch(root: string, branch: string): Promise<GitRun>
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

  /**
   * Reverts (tracked) or deletes (untracked) a single changed file outside
   * the project's own tracked file/`annotations/` — the whole-file
   * counterpart to that file's field-level Discard. Refuses (`ok: false`)
   * for a rename or an unresolved merge conflict, or an untracked directory
   * (deleted recursively instead of the `unlink` a plain file gets).
   *
   * `projectRelPath` is the open project's own `relPath` — the real guard
   * against this deleting the project's own untracked annotation files: the
   * renderer withholds the ↺ button for those rows too (see `GitDialog.tsx`'s
   * `isProjectOwnPath`), but that is UI, not enforcement, so this refuses the
   * same thing server-side whenever `relPath` is `projectRelPath` itself or
   * falls under its `annotationsRelDir(...)`.
   */
  discardFile(root: string, relPath: string, projectRelPath: string): Promise<GitRun>
}
