/**
 * Shapes shared between the Electron main process's git plumbing and the
 * renderer's `GitPlatform` seam. Nothing here talks to git or the DOM — see
 * `src/git/merge.ts` for the same rule applied to the merge itself.
 */

import type { ProjectFileEntry } from '../model/project'

/** The split-file form of a project (`splitProjectFiles`'s output): `project.json`
 *  plus a reconciled `annotations/` folder. Passed across IPC since commits/reverts span many files. */
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
  /** True for a remote-tracking ref ("origin/main"). Can be merged but not switched to
   *  (would detach HEAD), so the switcher filters these out; only as fresh as the last fetch. */
  remote: boolean
}

/**
 * The outcome of switching to another branch — mirrors `PullStart`'s shape.
 * Nothing is mutated yet except where `'merge'` says otherwise (see `beginBranchSwitch`).
 */
export type BranchSwitchStart =
  /** Nothing in the project is uncommitted — a plain `checkoutBranch` suffices. */
  | { kind: 'no-changes' }
  /** Something outside the project's own files is dirty too — only the project's
   *  own uncommitted changes can be carried across a switch. Nothing touched yet. */
  | { kind: 'other-files-dirty'; paths: string[] }
  | { kind: 'error'; message: string }
  | {
      kind: 'merge'
      /** The branch switched from — `abortBranchSwitch` returns here if the reviewer cancels. */
      sourceBranch: string
      /** The project's content at the commit switched away from, or `null` if it didn't exist there. */
      base: string | null
      /** The project's content plus the reviewer's uncommitted edits, captured before anything was touched. */
      ours: string
      /** The target branch's committed content. */
      theirs: string
    }

/**
 * The outcome of merging a ref into the current branch — a pull is one of these
 * ("merge `@{u}`"), so `PullStart` adds one pull-only case; both share handling via `applyMergeStart`.
 */
export type MergeStart =
  | { kind: 'up-to-date' }
  | { kind: 'fast-forwarded' }
  | { kind: 'dirty'; paths: string[] }
  | { kind: 'conflict-elsewhere'; paths: string[] }
  | { kind: 'error'; message: string }
  | {
      kind: 'merge'
      /** The ref that was merged — "origin/main" for a pull, a branch name otherwise. Shown to the reviewer. */
      ref: string
      /** The project's text at the merge base, or `null` if added independently on both sides. */
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
  /** True when the log was cut off at the cap (`LOG_MAX_COMMITS` in electron/main.ts) rather than genuinely ending there. */
  truncated: boolean
  error: string | null
}

/**
 * Raw material for a commit-history row's diff: the project's text at the commit
 * and its first parent. Deliberately text, not parsed — parsing/diffing is renderer-side.
 */
export type LogRevisionFetch =
  | { kind: 'initial' } // no parent — the first commit to touch this file
  | { kind: 'error'; message: string }
  | { kind: 'texts'; head: string; parent: string }

/**
 * Git operations against the user's own git installation. Electron-only —
 * see `PlatformAdapter.getGit()` for why, and what `null` means there.
 */
export interface GitPlatform {
  probe(): Promise<GitProbe>
  pickCloneDir(): Promise<string | null>
  clone(url: string, dest: string): Promise<CloneOutcome>
  /** The project-file picker opened inside `dir`. The caller reuses the ordinary
   *  project-open path for the result, so opening logic isn't duplicated. */
  pickProjectIn(dir: string): Promise<string | null>
  info(projectPath: string): Promise<GitRepoInfo | null>
  status(root: string): Promise<GitStatus>
  /** `amend` folds this into HEAD (`git commit --amend`) instead of creating a new commit. */
  commit(root: string, paths: string[], message: string, amend: boolean): Promise<GitRun>
  /** HEAD's commit message (`%B`, trailing newline stripped) — prefills the commit
   *  field when switching to amend. `null` when there's no HEAD commit yet. */
  lastCommitMessage(root: string): Promise<string | null>
  push(root: string): Promise<GitRun>
  beginPull(root: string, relPath: string): Promise<PullStart>
  /**
   * Merges `ref` (local or remote-tracking) into the current branch — same as
   * `beginPull` minus the upstream lookup, so it shares `finishPull`/`abortPull`. Fetches first if `ref` is remote-tracking.
   */
  beginMerge(root: string, relPath: string, ref: string): Promise<MergeStart>
  /** `git log`, scoped to `relPath` and its `annotations/` dir — for the
   *  commit-history panel. Capped, not paginated; `truncated` says so. */
  logBegin(root: string, relPath: string): Promise<LogBeginResult>
  /** The two revisions a history row's diff needs, fetched but not parsed (see `LogRevisionFetch`). */
  logDiff(root: string, relPath: string, rev: string): Promise<LogRevisionFetch>
  /** Writes, stages and commits the resolved project — used for both a pull and a
   *  `beginMerge`, since both leave the repo mid-merge with `MERGE_HEAD` set. */
  finishPull(root: string, relPath: string, working: SplitProject): Promise<GitRun>
  /** `git merge --abort` — undoes whichever of `beginPull`/`beginMerge` is in
   *  flight, leaving the work tree exactly as it was. */
  abortPull(root: string): Promise<GitRun>
  /** HEAD's copy of the project (`relPath` + `annotations/`, reassembled into one text),
   *  for field-level review in `src/git/changes.ts`. `null` if untracked/never committed. */
  headContent(root: string, relPath: string): Promise<string | null>
  /** Working-tree content reassembled from disk (not the app's in-memory project) —
   *  the other half of what `changes.ts` diffs. `null` if missing/unreadable. */
  workingContent(root: string, relPath: string): Promise<string | null>
  /**
   * Commits `committed` plus whatever's on disk at `otherPaths`, then writes `working`
   * back unconditionally afterward — see `git:commitPartial` in electron/main.ts for why.
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
  /** Writes `working` to the project without staging/committing — the write-counterpart
   *  to `workingContent`, for reverting local edits without a commit. */
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
  /** A plain, no-local-changes checkout — safe only after `beginBranchSwitch` returns
   *  `'no-changes'`, or outside a project's repository entirely. */
  checkoutBranch(root: string, branch: string): Promise<GitRun>
  /**
   * Checks whether switching to `branch` is safe, and if so, does the switch (stash,
   * checkout, read the three revisions) — see the `electron/main.ts` handler for details.
   */
  beginBranchSwitch(root: string, relPath: string, branch: string): Promise<BranchSwitchStart>
  /** Writes the resolved project onto the checked-out target branch and drops the
   *  stash `beginBranchSwitch` created — the branch-switch counterpart to `finishPull`. */
  finishBranchSwitch(root: string, relPath: string, resolved: SplitProject): Promise<GitRun>
  /** Checks back out to `sourceBranch` and restores the stashed changes — the
   *  branch-switch counterpart to `abortPull`, which must reverse a completed checkout (hence needing `sourceBranch`). */
  abortBranchSwitch(root: string, sourceBranch: string): Promise<GitRun>

  /**
   * Reverts (tracked) or deletes (untracked) a file outside the project's own tracked
   * file/`annotations/` — whole-file counterpart to field-level Discard. Refuses for a
   * rename, unresolved conflict, or when `relPath` is `projectRelPath` itself or under
   * its `annotationsRelDir` (server-side enforcement backing the renderer's UI guard).
   */
  discardFile(root: string, relPath: string, projectRelPath: string): Promise<GitRun>
}
