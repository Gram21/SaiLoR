import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { getPlatform } from '../platform'
import type { SaveHandle } from '../platform'
import { loadProject, splitProjectFiles, ProjectLoadError, type Project } from '../model/project'
import type { SplitProject } from '../git/types'
import type { FieldValue } from '../model/annotations'
import {
  mergeProjects,
  applyResolutions,
  type FieldConflict,
  type MergeNote,
  type Resolutions,
} from '../git/merge'
import { detectFieldChanges, composeContents, type DetectedChanges, type Disposition } from '../git/changes'
import { repoNameFromUrl } from '../git/url'
import { annotationsRelDir } from '../git/relpath'
import { stashBranchName } from '../git/stash'
import { gitErrorText } from '../git/output'
import type {
  GitProbe,
  GitRepoInfo,
  GitRun,
  GitStatus,
  GitBranch,
  MergeStart,
  CommitRecord,
  AnnotationAuthors,
  StashEntry,
} from '../git/types'
import { useStore } from './store'

/**
 * State for the git flows (import + commit/pull/push panel), kept out of the
 * main store like `aiStore` — a self-contained mode the ordinary annotation
 * path never needs to know about. Dependency direction is one-way: this
 * reads/drives `useStore`, never the reverse, so refreshing `repo` on project
 * change is an `App.tsx` effect, not a call from `store.ts`.
 */

interface CloneState {
  phase: 'setup' | 'cloning' | 'error' | 'done'
  url: string
  /** The folder the reviewer picked to clone *into*. */
  parent: string | null
  /** Exactly what git printed. Shown verbatim, never summarised. */
  error: string
  dest: string | null
  /** Wall-clock start, for the elapsed-seconds line — a clone of a repo of PDFs is slow. */
  startedAt: number
}

/**
 * A field-level three-way merge in progress. `GitMergeDialog` renders all
 * three kinds identically; only finish/cancel differ, and only for
 * `branch-switch` — it alone moved HEAD, so it needs
 * `finishBranchSwitch`/`abortBranchSwitch` and `sourceBranch` to check back
 * out to on cancel. `pull`/`merge-branch` are an ordinary git merge, finished
 * and aborted by `finishPull`/`abortPull`.
 */
type MergeSource =
  | { kind: 'pull' }
  | { kind: 'merge-branch' }
  | { kind: 'branch-switch'; sourceBranch: string }

interface MergeState {
  source: MergeSource
  /** The other side's name (upstream ref, or branch name) — shown as-is so
   *  "Your changes and {ref}'s both changed these fields." reads for all three. */
  ref: string
  merged: Project
  conflicts: FieldConflict[]
  resolutions: Resolutions
  /** Rows the reviewer actually decided — a row starts pre-filled with our
   *  value so the control has something to show, but that isn't a decision. */
  decided: Record<string, true>
  notes: MergeNote[]
}

/**
 * Field-level review of the open project's own file, when it's a tracked
 * modification that parses as a project on both HEAD and the working tree —
 * see `refreshFieldReview`. `null` for every other case (untracked, deleted,
 * unparseable, or structural), which falls back to the plain file-level
 * checkbox `panel.selected` handles for every other changed file.
 */
interface FieldReviewState {
  head: Project
  working: Project
  changes: DetectedChanges
  /** Absent means 'use' — a reviewer who never touches a row still commits
   *  everything they changed, matching the plain checkbox's default. */
  decisions: Record<string, Disposition>
}

/**
 * Asked when the reviewer picks a different branch with uncommitted changes —
 * see `requestSwitchBranch`. `'carryOver'` starts the merge flow (`MergeState`
 * above); `'commitFirst'`/`'cancel'` both just close this without switching
 * (separate buttons only so the wording matches intent — the effect is identical).
 */
interface BranchSwitchPromptState {
  branch: string
}

/**
 * The "New branch…" dialog's own state. `error` is distinct from
 * `panel.error` so a failed name isn't lost behind the dialog the moment
 * something else touches the shared one. After a plain `git branch` creates
 * it, switching runs the ordinary `requestSwitchBranch` flow — a freshly cut
 * branch shares its parent's commit, so that switch can never conflict.
 */
interface NewBranchPromptState {
  name: string
  error: string | null
}

/**
 * The "Merge branch…" dialog — deliberately its own small prompt, not the
 * inline branch-switcher `<select>`, so merging (rare) doesn't sit as
 * prominently as Commit/Pull/Push. `branch` always has a value since the
 * button that opens this is itself hidden when no mergeable branch exists.
 */
interface MergeBranchPromptState {
  branch: string
}

/** The "- Delete branch…" dialog — mirrors `MergeBranchPromptState`, always
 *  defaulting to a real, non-current branch since the sentinel that opens
 *  this is only offered when one exists. */
interface DeleteBranchPromptState {
  branch: string
}

/**
 * One commit row's field-level diff, computed by `loadCommitDiff` from the raw
 * text `GitPlatform.logDiff` fetches — parsed on the renderer side, same as
 * every other diff in this store.
 */
export type LogDiffResult =
  | { kind: 'initial' } // no parent — the first commit to touch this file
  | { kind: 'structural' } // a structural field changed, or either side failed to parse
  | { kind: 'error'; message: string }
  | { kind: 'changes'; changes: DetectedChanges }

/** The commit-history panel's state — independent of `dirty`/`phase` since
 *  browsing history never touches the working tree. */
interface HistoryState {
  commits: CommitRecord[]
  truncated: boolean
  error: string | null
  /** Keyed by commit hash — computed lazily per hash, not for the whole list
   *  (see `loadCommitDiff`). */
  diffs: Record<string, LogDiffResult | 'loading'>
}

interface PanelState {
  phase: 'idle' | 'loading' | 'working'
  status: GitStatus | null
  message: string
  /** When true, the next commit folds into HEAD (`git commit --amend`)
   *  instead of creating a new one — see `setAmend`. */
  amend: boolean
  /** Paths ticked for the next commit — every changed file *except* the open
   *  project's own, whenever `fieldReview` is handling that one instead. */
  selected: Record<string, true>
  fieldReview: FieldReviewState | null
  error: string | null
  notice: string | null
  merge: MergeState | null
  branchSwitchPrompt: BranchSwitchPromptState | null
  newBranchPrompt: NewBranchPromptState | null
  mergeBranchPrompt: MergeBranchPromptState | null
  deleteBranchPrompt: DeleteBranchPromptState | null
  history: HistoryState | null
}

interface GitState {
  /** null until probed once per launch. */
  probe: GitProbe | null
  /** Where the open project sits git-wise; null when it is not in a repository,
   *  there is no project, or git is unavailable. */
  repo: GitRepoInfo | null
  /**
   * Who last committed each annotation file — one `git log` per repository,
   * read once, so the per-paper "somebody has already read this" check costs
   * nothing at the point of use. Null outside a repository, or before it has
   * loaded. See `src/git/seatOwner.ts` for why this is per paper.
   */
  annotationAuthors: AnnotationAuthors | null
  /**
   * Set when this project's repository needs SaiLoR's git rules *and* already
   * holds rules of somebody's own, so the change has to be asked about rather
   * than simply made. Null otherwise — including while it is being made, which
   * happens without a prompt when there is nothing of anyone else's to
   * overwrite. See `src/git/repoSetup.ts`.
   */
  repoSetupPrompt: { paths: string[] } | null
  /** What the last automatic or accepted setup did, for a small popup — the
   *  files land in a commit the reviewer did not type, so it should not happen
   *  invisibly. Cleared when dismissed. See `RepoSetupToast`. */
  repoSetupNotice: { kind: 'ok' | 'error'; text: string } | null
  /** Every stash in the repository, newest first — see `src/git/stash.ts`.
   *  Kept outside `panel` so the toolbar can mention SaiLoR's own stashes
   *  while the panel is closed: parked work nobody remembers is lost work. */
  stashes: StashEntry[]
  clone: CloneState | null
  panel: PanelState | null
  /** Local branches, refreshed whenever the panel opens/refreshes — for the
   *  branch switcher. Empty when the panel is closed or git is unavailable. */
  branches: GitBranch[]

  probeGit: () => Promise<void>
  /** Refetch `branches` — called on panel open/refresh and after any
   *  successful branch switch. */
  refreshBranches: () => Promise<void>
  /** Called from App.tsx whenever the open project's save handle changes. */
  refreshRepo: (handle: SaveHandle | null) => Promise<void>
  /** Re-read `annotationAuthors` for the open project. Called by
   *  `refreshRepo`, and after a commit — which is exactly what changes who
   *  last wrote a reading. */
  refreshSeatOwners: () => Promise<void>
  /**
   * Bring the project's `.gitattributes`/`.gitignore` up to what SaiLoR needs.
   * Applies silently when there is nothing of the user's to overwrite, and
   * otherwise raises `repoSetupPrompt` and waits. Called once per repository
   * on open; safe to call again, since an up-to-date repository is a no-op.
   */
  ensureRepoSetup: () => Promise<void>
  /** Answer `repoSetupPrompt`. */
  resolveRepoSetup: (accept: boolean) => Promise<void>
  dismissRepoSetupNotice: () => void

  refreshStashes: () => Promise<void>
  /** Stash this project's uncommitted changes. */
  runStashPush: (message: string) => Promise<void>
  /** Put a stash back — all or nothing; see `restoreStash`. */
  runStashRestore: (sha: string) => Promise<void>
  /** Restore a stash onto a new branch where it cannot conflict. */
  runStashBranch: (sha: string) => Promise<void>
  runStashDrop: (sha: string) => Promise<void>

  openClone: () => void
  closeClone: () => void
  setCloneUrl: (url: string) => void
  pickCloneParent: () => Promise<void>
  runClone: () => Promise<void>
  /** Return to the clone-setup form, keeping what the reviewer already typed. */
  backToCloneSetup: () => void
  openClonedProject: () => Promise<void>

  openPanel: () => Promise<void>
  closePanel: () => void
  refreshStatus: () => Promise<void>
  toggleSelected: (path: string) => void
  setFieldDisposition: (id: string, disposition: Disposition) => void
  /** Sets every field/paper row in the current field review at once — like
   *  `GitMergeDialog`'s "Use all mine"/"Use all remote". */
  setAllFieldDispositions: (disposition: Disposition) => void
  setCommitMessage: (message: string) => void
  /** Toggling amend on prefills an empty message with HEAD's commit message,
   *  fetched fresh so it matches whatever HEAD actually is right now. Never
   *  overwrites text the reviewer already typed. */
  setAmend: (amend: boolean) => Promise<void>
  runCommit: () => Promise<void>
  /** Apply the field review's current 'discard' decisions to the working
   *  tree — revert those rows to HEAD's value — WITHOUT making a commit. */
  runDiscard: () => Promise<void>
  runPush: () => Promise<void>
  runPull: () => Promise<void>
  /**
   * Merge `ref` into the current branch, same flow as `runPull` against an
   * explicit ref: fast-forward or clean merge commits and reloads right
   * away, disagreement opens `GitMergeDialog`. No-op for the checked-out branch.
   */
  runMergeBranch: (ref: string) => Promise<void>
  /** Opens the "Merge branch…" dialog, defaulting to the first mergeable
   *  branch (always exists when the calling button is shown). */
  openMergeBranchPrompt: () => void
  setMergeBranchPromptBranch: (branch: string) => void
  closeMergeBranchPrompt: () => void
  /** Runs `runMergeBranch` against `panel.mergeBranchPrompt.branch` and closes the dialog. */
  confirmMergeBranchPrompt: () => Promise<void>

  /** Opens the "- Delete branch…" dialog, defaulting to the first local
   *  non-current branch (always exists when the sentinel is shown). */
  openDeleteBranchPrompt: () => void
  setDeleteBranchPromptBranch: (branch: string) => void
  closeDeleteBranchPrompt: () => void
  /** `git branch -d` against `panel.deleteBranchPrompt.branch`; on failure
   *  (typically "not fully merged"), git's refusal text becomes `panel.error`. */
  confirmDeleteBranchPrompt: () => Promise<void>

  /** Opens the commit-history panel for the open project's file and fetches its `git log`. */
  openHistory: () => Promise<void>
  closeHistory: () => void
  /** Fetches and computes the field-level diff for `hash` once — no-op if
   *  already fetched/in flight; only called when a commit row is expanded. */
  loadCommitDiff: (hash: string) => Promise<void>

  /**
   * Reverts (tracked) or deletes (untracked) a single changed file other
   * than the project's own — the whole-file counterpart to field-level
   * Discard. Unlike `runDiscard`, needs no `dirty` guard or resync
   * afterward: `path` can never be the project's own tracked file or
   * anything under `annotations/` (enforced both in `GitDialog.tsx` and
   * server-side in `git:discardFile`), so nothing here is ever read by the
   * in-memory `project`.
   */
  runDiscardFile: (path: string) => Promise<void>

  dismissPanelMessage: () => void

  resolveConflict: (id: string, value: FieldValue) => void
  takeSide: (id: string, side: 'ours' | 'theirs') => void
  /** `ids`, when given, scopes the bulk action to those conflicts only.
   *  Omitted means every conflict. */
  takeAll: (side: 'ours' | 'theirs', ids?: string[]) => void
  finishMerge: () => Promise<void>
  cancelMerge: () => Promise<void>

  /**
   * The reviewer picked `branch`. Switches right away if nothing's
   * uncommitted; otherwise opens the three-way prompt (`branchSwitchPrompt`):
   * commit first, carry changes over (merging as needed), or cancel.
   */
  requestSwitchBranch: (branch: string) => void
  resolveBranchSwitchPrompt: (choice: 'commitFirst' | 'carryOver' | 'cancel') => Promise<void>

  /** Opens the "New branch…" dialog with an empty name. */
  openNewBranchPrompt: () => void
  setNewBranchName: (name: string) => void
  closeNewBranchPrompt: () => void
  /** Creates `panel.newBranchPrompt.name` at the current commit, then runs
   *  the ordinary `requestSwitchBranch` flow against it — a name git itself
   *  rejects (empty, invalid, already taken) surfaces as
   *  `newBranchPrompt.error` and leaves the dialog open to fix. */
  createAndSwitchBranch: () => Promise<void>
}

/** `${parent}/${name}` — there is no `path` module available in the browser
 *  bundle this store also ships in, so the join is built by hand. `parent`
 *  always comes back from a native folder picker, so it never ends in a
 *  separator; a mixed "/"-in-a-backslash-path is something both git and
 *  Node's fs accept fine on Windows. */
function joinPath(parent: string, name: string): string {
  return `${parent}/${name}`
}

/** The open project's JSON changed underneath it on disk — reload it the
 *  ordinary way. `openRecent(path)` is exactly right here: on Electron the
 *  recents id **is** the absolute file path, so this reopens the same file
 *  through the normal load path (parses, normalizes, refreshes recents)
 *  rather than duplicating any of that. */
async function reloadOpenProject(): Promise<void> {
  const path = useStore.getState().saveHandle?.path
  if (path) await useStore.getState().openRecent(path)
}

function mergeParseError(rev: string, err: unknown): string {
  const message = err instanceof ProjectLoadError ? err.message : err instanceof Error ? err.message : String(err)
  return `The project file at ${rev} is not a valid project: ${message} The merge has been aborted; nothing changed.`
}

/** `splitProjectFiles`, reshaped into the `{metaText, files}` the `GitPlatform`
 *  write calls take across the IPC boundary. */
function toSplitProject(project: Project): SplitProject {
  const { meta, files } = splitProjectFiles(project)
  return { metaText: JSON.stringify(meta, null, 2), files }
}

export const useGitStore = create<GitState>()(
  immer((set, get) => {
    /**
     * Shared by the zero-conflict fast path (`runPull`/`runBranchSwitchCarryOver`)
     * and `finishMerge`. On failure the repo is still mid-merge, so `panel.merge`
     * is left in place — Cancel merge must stay reachable.
     */
    async function doFinish(
      source: MergeSource,
      ref: string,
      merged: Project,
      conflicts: FieldConflict[],
      resolutions: Resolutions,
      notes: MergeNote[],
    ): Promise<void> {
      const git = getPlatform().getGit()
      const repo = get().repo
      if (!git || !repo) return
      const resolved = applyResolutions(merged, conflicts, resolutions)
      const r =
        source.kind === 'branch-switch'
          ? await git.finishBranchSwitch(repo.root, repo.relPath, toSplitProject(resolved))
          : await git.finishPull(repo.root, repo.relPath, toSplitProject(resolved))
      if (!r.ok) {
        set((s) => {
          if (s.panel) {
            s.panel.error = gitErrorText(r)
            // Back-fill `panel.merge` if the conflict path didn't already set it,
            // so Cancel merge stays reachable rather than wedging a repo with a
            // failed finish (e.g. unset git user.name/email) and no way to abort.
            if (!s.panel.merge) {
              s.panel.merge = { source, ref, merged, conflicts, resolutions, decided: {}, notes }
            }
          }
        })
        return
      }
      await reloadOpenProject()
      const noteText = notes.length > 0 ? ` ${notes.map((n) => n.message).join(' ')}` : ''
      const notice =
        source.kind === 'pull'
          ? `Merged ${ref}.${noteText} Push when you are ready.`
          : source.kind === 'merge-branch'
            ? `Merged ${ref} into ${repo.branch ?? 'the current branch'}.${noteText} Push when you are ready.`
            : `Switched to ${ref}, carrying your changes over.${noteText}`
      set((s) => {
        if (s.panel) {
          s.panel.merge = null
          s.panel.notice = notice
        }
      })
      if (source.kind === 'branch-switch') {
        await get().refreshRepo(useStore.getState().saveHandle)
        await get().refreshBranches()
      }
      await get().refreshStatus()
    }

    /**
     * `git status` sees disk, not the reviewer's unsaved in-memory annotations;
     * a fast-forward/finished merge reloads from disk, which would silently
     * discard unsaved work without this check. `verb` reads into the message.
     */
    function setPanelWorking(): void {
      set((s) => {
        if (s.panel) {
          s.panel.phase = 'working'
          s.panel.error = null
          s.panel.notice = null
        }
      })
    }

    function finishPanelWork(notice: string | null, error: string | null): void {
      set((s) => {
        if (s.panel) {
          s.panel.phase = 'idle'
          s.panel.notice = notice
          s.panel.error = error
        }
      })
    }

    /** A stash operation that rewrites the working tree: run it, then reload
     *  the open project from disk, since what it holds in memory no longer
     *  matches the files. */
    async function runStashOperation(op: () => Promise<GitRun>, successNotice: string): Promise<void> {
      setPanelWorking()
      const r = await op()
      if (r.ok) await useStore.getState().resyncProjectFromDisk()
      finishPanelWork(r.ok ? successNotice : null, r.ok ? null : gitErrorText(r))
      await get().refreshStatus()
    }

    function guardDirtyForMerge(verb: string): boolean {
      if (!useStore.getState().dirty) return true
      set((s) => {
        if (s.panel) {
          s.panel.error =
            `Save the project first — ${verb} works on the file on disk, and your unsaved ` +
            'annotations would be lost.'
        }
      })
      return false
    }

    /**
     * Everything a merge does once git has classified it — shared by `runPull`
     * and `runMergeBranch`, which differ only in how they name the other side.
     * `ffLabel` is what a fast-forward reports having moved to.
     */
    async function applyMergeStart(start: MergeStart, source: MergeSource, ffLabel: string): Promise<void> {
      const git = getPlatform().getGit()
      const repo = get().repo
      if (!git || !repo) return

      const fail = (error: string) =>
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.error = error
          }
        })

      if (start.kind === 'up-to-date') {
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.notice = 'Already up to date.'
          }
        })
        return
      }
      if (start.kind === 'fast-forwarded') {
        await reloadOpenProject()
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.notice = `Updated to ${ffLabel}.`
          }
        })
        await get().refreshStatus()
        return
      }
      if (start.kind === 'dirty') {
        fail(`This repository has uncommitted changes: ${start.paths.join(', ')}. Commit them first.`)
        return
      }
      if (start.kind === 'conflict-elsewhere') {
        fail(
          `Git could not merge these files on its own: ${start.paths.join(', ')}. SaiLoR only ` +
            'knows how to merge the project JSON — resolve these with git and try again. The ' +
            'merge has been aborted; nothing changed.',
        )
        return
      }
      if (start.kind === 'error') {
        fail(start.message)
        return
      }

      // start.kind === 'merge': parse each revision independently, so a
      // parse failure names exactly which one is unreadable.
      let base: Project | null
      try {
        base = start.base === null ? null : loadProject(start.base)
      } catch (err) {
        await git.abortPull(repo.root)
        fail(mergeParseError('the merge base', err))
        return
      }
      let ours: Project
      try {
        ours = loadProject(start.ours)
      } catch (err) {
        await git.abortPull(repo.root)
        fail(mergeParseError('HEAD (your copy)', err))
        return
      }
      let theirs: Project
      try {
        theirs = loadProject(start.theirs)
      } catch (err) {
        await git.abortPull(repo.root)
        fail(mergeParseError(start.ref, err))
        return
      }

      const outcome = mergeProjects(base, ours, theirs)
      if (outcome.kind === 'refused') {
        await git.abortPull(repo.root)
        fail([outcome.reason, ...outcome.details].join('\n'))
        return
      }

      if (outcome.conflicts.length === 0) {
        set((s) => {
          if (s.panel) s.panel.phase = 'idle'
        })
        await doFinish(source, start.ref, outcome.merged, outcome.conflicts, {}, outcome.notes)
        return
      }

      set((s) => {
        if (s.panel) {
          s.panel.phase = 'idle'
          s.panel.merge = {
            source,
            ref: start.ref,
            merged: outcome.merged,
            conflicts: outcome.conflicts,
            resolutions: {},
            decided: {},
            notes: outcome.notes,
          }
        }
      })
    }

    /**
     * Recomputes `panel.fieldReview` for the open project's own file. Every
     * failure mode (untracked, unparseable, structural change) lands on
     * `null` — falls back to the plain file-level checkbox, never surfaces
     * as an error, since "can't review field by field" is routine.
     *
     * Existing decisions survive a refresh that leaves the same fields
     * changed (a ↻ click must not reset a reviewer's per-row choices).
     */
    async function refreshFieldReview(repo: GitRepoInfo, status: GitStatus): Promise<void> {
      const git = getPlatform().getGit()
      if (!git) return

      // A change under `annotations/` counts too, not just `project.json` —
      // most edits are exactly that now that annotations live in per-paper
      // files. Unlike `relPath`, an untracked ('??') annotation file still
      // counts: a first answer for a paper creates a new file while
      // `project.json` stays clean — the routine case field review exists
      // for. `relPath` itself untracked means never committed, so there's
      // nothing to diff against — that case is still skipped.
      const dir = annotationsRelDir(repo.relPath)
      const inAnnotationsDir = (p: string) => p === dir || p.startsWith(`${dir}/`)
      const inStatus = status.changes.some(
        (c) => (c.path === repo.relPath && c.code !== '??') || inAnnotationsDir(c.path),
      )
      if (!inStatus) {
        set((s) => {
          if (s.panel) s.panel.fieldReview = null
        })
        return
      }

      const clear = () =>
        set((s) => {
          if (s.panel) s.panel.fieldReview = null
        })

      try {
        const [headText, workingText] = await Promise.all([
          git.headContent(repo.root, repo.relPath),
          git.workingContent(repo.root, repo.relPath),
        ])
        if (headText === null || workingText === null) {
          clear()
          return
        }
        const head = loadProject(headText)
        const working = loadProject(workingText)
        const changes = detectFieldChanges(head, working)
        if (!changes || (changes.fields.length === 0 && changes.papers.length === 0)) {
          clear()
          return
        }
        set((s) => {
          if (!s.panel) return
          const validIds = new Set([...changes.fields.map((f) => f.id), ...changes.papers.map((p) => p.id)])
          const decisions: Record<string, Disposition> = {}
          for (const [id, d] of Object.entries(s.panel.fieldReview?.decisions ?? {})) {
            if (validIds.has(id)) decisions[id] = d
          }
          s.panel.fieldReview = { head, working, changes, decisions }
          // The open project's own file is now handled here — never let it
          // also linger as a plain file-level tick from before this resolved.
          delete s.panel.selected[repo.relPath]
        })
      } catch {
        // Either revision failed to parse as a project — fall back silently.
        clear()
      }
    }

    /**
     * Guard `runCommit`/`runDiscard` share before writing: both compose from
     * `review.working`, a snapshot nothing re-reads afterward, so if the file
     * changed on disk since, composing against it would silently discard that
     * change — e.g. the dirty banner's "Save project" writes to disk without
     * refreshing `panel.fieldReview`, so `dirty` flips false and committing
     * would overwrite the save.
     *
     * Compares parsed `Project` objects, not raw text, since the same parser
     * normalizes both reads identically regardless of formatting. Returns
     * true when safe to proceed; false means the caller must stop — the
     * review has been refreshed and `panel.error` explains why.
     */
    async function guardFieldReviewFresh(repo: GitRepoInfo, review: FieldReviewState): Promise<boolean> {
      const git = getPlatform().getGit()
      if (!git) return false
      let current: Project | null = null
      try {
        const text = await git.workingContent(repo.root, repo.relPath)
        current = text === null ? null : loadProject(text)
      } catch {
        current = null
      }
      if (current && JSON.stringify(current) === JSON.stringify(review.working)) return true

      await get().refreshStatus()
      set((s) => {
        if (s.panel) {
          s.panel.phase = 'idle'
          s.panel.error =
            `${repo.relPath} changed on disk since this review was loaded, so nothing was written. ` +
            'The review below has been reloaded from the current file — check your choices again.'
        }
      })
      return false
    }

    const storeApi: GitState = {
      probe: null,
      repo: null,
      annotationAuthors: null,
      repoSetupPrompt: null,
      repoSetupNotice: null,
      stashes: [],
      clone: null,
      panel: null,
      branches: [],

      probeGit: async () => {
        const git = getPlatform().getGit()
        if (!git) return
        const probe = await git.probe()
        set((s) => {
          s.probe = probe
        })
      },

      refreshRepo: async (handle) => {
        // A new project may be in no repository at all — clear first so a
        // stale "Git" button doesn't linger while the real answer loads.
        set((s) => {
          s.repo = null
          s.annotationAuthors = null
          s.repoSetupPrompt = null
          s.stashes = []
        })
        const git = getPlatform().getGit()
        if (!git || !handle?.path) return
        const info = await git.info(handle.path)
        // The open project may have changed again while this was in flight.
        if (useStore.getState().saveHandle?.path !== handle.path) return
        set((s) => {
          s.repo = info
        })
        await get().refreshSeatOwners()
        await get().ensureRepoSetup()
        await get().refreshStashes()
      },

      ensureRepoSetup: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo) return
        try {
          const status = await git.repoSetupStatus(repo.root, repo.relPath)
          if (status.upToDate) return
          if (status.needsConsent) {
            set((s) => {
              s.repoSetupPrompt = { paths: status.paths }
            })
            return
          }
          await get().resolveRepoSetup(true)
        } catch {
          // Configuring the repository is a convenience, never the reason a
          // reviewer opened the project. A repository that cannot be read
          // just goes unconfigured.
        }
      },

      resolveRepoSetup: async (accept) => {
        set((s) => {
          s.repoSetupPrompt = null
        })
        if (!accept) return
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo) return
        const r = await git.applyRepoSetup(repo.root, repo.relPath)
        set((s) => {
          s.repoSetupNotice = r.ok
            ? { kind: 'ok', text: "Added SaiLoR's git rules for this project (.gitattributes, .gitignore) and committed them." }
            : { kind: 'error', text: `SaiLoR could not configure this repository: ${gitErrorText(r)}` }
        })
        // The commit changed HEAD and the working tree.
        await get().refreshStatus()
      },

      dismissRepoSetupNotice: () => {
        set((s) => {
          s.repoSetupNotice = null
        })
      },

      refreshStashes: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo) return
        try {
          const stashes = await git.stashList(repo.root)
          if (get().repo === repo) set((s) => {
            s.stashes = stashes
          })
        } catch {
          // A list that cannot be read is shown as empty rather than as an
          // error: nothing else in the panel depends on it.
        }
      },

      runStashPush: async (message) => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo || !get().panel) return
        // The stash takes what is on disk; unsaved edits exist only in memory
        // and the reload afterwards would silently drop them.
        if (!guardDirtyForMerge('stashing')) return
        await runStashOperation(
          () => git.stashPush(repo.root, repo.relPath, message),
          'Stashed. Your changes to this project are parked below until you restore them.',
        )
      },

      runStashRestore: async (sha) => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo || !get().panel) return
        if (!guardDirtyForMerge('restoring a stash')) return
        setPanelWorking()
        const r = await git.stashRestore(repo.root, repo.relPath, sha)
        if (r.kind === 'restored' || r.kind === 'restored-kept') {
          await useStore.getState().resyncProjectFromDisk()
          finishPanelWork(
            r.kind === 'restored'
              ? 'Restored.'
              : `Restored, but the stash could not be removed afterwards (${r.message}). It now repeats ` +
                  'what is already in your files, so deleting it is safe.',
            null,
          )
        } else if (r.kind === 'dirty') {
          finishPanelWork(
            null,
            `Commit or stash these first — restoring onto uncommitted work would mix two sets of edits: ` +
              `${r.paths.join(', ')}. Nothing was changed.`,
          )
        } else if (r.kind === 'conflict') {
          finishPanelWork(
            null,
            'This stash no longer fits the current commit — the same files changed since it was made. ' +
              'Nothing was changed and the stash is kept. Use "Restore on a new branch" to put it back ' +
              'where it cannot conflict, then commit there and bring it over with Merge branch…, which ' +
              'resolves any overlap field by field.',
          )
        } else if (r.kind === 'gone') {
          finishPanelWork(null, 'That stash no longer exists.')
        } else {
          finishPanelWork(null, r.message)
        }
        await get().refreshStatus()
      },

      runStashBranch: async (sha) => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo || !get().panel) return
        if (!guardDirtyForMerge('restoring a stash')) return
        const entry = get().stashes.find((e) => e.sha === sha)
        if (!entry) return
        const branch = stashBranchName(entry, get().branches.map((b) => b.name))
        await runStashOperation(
          () => git.stashBranch(repo.root, repo.relPath, sha, branch),
          `Restored onto the new branch "${branch}", which you are now on. Commit there, switch back, ` +
            'and use Merge branch… to bring the changes over.',
        )
        // A new branch, and HEAD moved onto it.
        await get().refreshRepo(useStore.getState().saveHandle)
        await get().refreshBranches()
      },

      runStashDrop: async (sha) => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo || !get().panel) return
        setPanelWorking()
        const r = await git.stashDrop(repo.root, sha)
        finishPanelWork(r.ok ? 'Stash deleted.' : null, r.ok ? null : gitErrorText(r))
        await get().refreshStashes()
      },

      refreshSeatOwners: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        const project = useStore.getState().project
        if (!git || !repo || !project || project.reviewers <= 1) {
          set((s) => {
            s.annotationAuthors = null
          })
          return
        }
        // Best-effort: a repository this can't read says nothing about who
        // has read what, which is the same state as a project outside git.
        // Never a blocking error — nothing here is worth interrupting a
        // reviewer over.
        try {
          const authors = await git.annotationAuthors(repo.root, repo.relPath)
          if (get().repo === repo) set((s) => {
            s.annotationAuthors = authors
          })
        } catch {
          set((s) => {
            s.annotationAuthors = null
          })
        }
      },

      openClone: () => {
        set((s) => {
          s.clone = { phase: 'setup', url: '', parent: null, error: '', dest: null, startedAt: 0 }
        })
      },

      closeClone: () => {
        set((s) => {
          s.clone = null
        })
      },

      setCloneUrl: (url) => {
        set((s) => {
          if (s.clone) s.clone.url = url
        })
      },

      pickCloneParent: async () => {
        const git = getPlatform().getGit()
        if (!git) return
        const dir = await git.pickCloneDir()
        if (!dir) return
        set((s) => {
          if (s.clone) s.clone.parent = dir
        })
      },

      runClone: async () => {
        const git = getPlatform().getGit()
        const clone = get().clone
        if (!git || !clone) return
        const url = clone.url.trim()
        const name = repoNameFromUrl(url)
        if (!clone.parent || !name) return
        const dest = joinPath(clone.parent, name)
        set((s) => {
          if (s.clone) {
            s.clone.phase = 'cloning'
            s.clone.startedAt = Date.now()
          }
        })
        const r = await git.clone(url, dest)
        set((s) => {
          if (!s.clone) return
          if (r.ok) {
            s.clone.phase = 'done'
            s.clone.dest = r.dest
          } else {
            s.clone.phase = 'error'
            s.clone.error = r.error
          }
        })
      },

      backToCloneSetup: () => {
        set((s) => {
          if (s.clone) {
            s.clone.phase = 'setup'
            s.clone.error = ''
          }
        })
      },

      openClonedProject: async () => {
        const git = getPlatform().getGit()
        const clone = get().clone
        if (!git || !clone?.dest) return
        const p = await git.pickProjectIn(clone.dest)
        if (!p) return
        // `requestOpenRecent`, not `openRecent`: this replaces whatever project
        // is on screen, so it must go through the same dirty-project prompt as Ctrl+O.
        useStore.getState().requestOpenRecent(p)
        // Only dismiss the clone panel once the open actually happened —
        // `requestOpenRecent` may just queue behind the save prompt, and if that's
        // cancelled the reviewer would be left with no project and no way back.
        if (!useStore.getState().pendingAfterPrompt) get().closeClone()
      },

      openPanel: async () => {
        set((s) => {
          s.panel = {
            phase: 'idle',
            status: null,
            message: '',
            amend: false,
            selected: {},
            fieldReview: null,
            error: null,
            notice: null,
            merge: null,
            branchSwitchPrompt: null,
            newBranchPrompt: null,
            mergeBranchPrompt: null,
            deleteBranchPrompt: null,
            history: null,
          }
        })
        await get().refreshStatus()
        await get().refreshBranches()
        // Default tick: only the open project's own file (when not already
        // handled by field review) — clicking Git means "my annotations".
        const repo = get().repo
        const panel = get().panel
        if (repo && !panel?.fieldReview && panel?.status?.changes.some((c) => c.path === repo.relPath)) {
          set((s) => {
            if (s.panel) s.panel.selected = { [repo.relPath]: true }
          })
        }
      },

      closePanel: () => {
        set((s) => {
          s.panel = null
        })
      },

      refreshStatus: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo) return
        set((s) => {
          if (s.panel) s.panel.phase = 'loading'
        })
        try {
          const status = await git.status(repo.root)
          set((s) => {
            if (!s.panel) return
            s.panel.status = status
            s.panel.phase = 'idle'
            const paths = new Set(status.changes.map((c) => c.path))
            for (const p of Object.keys(s.panel.selected)) {
              if (!paths.has(p)) delete s.panel.selected[p]
            }
          })
          await refreshFieldReview(repo, status)
          await get().refreshStashes()
        } catch (err) {
          set((s) => {
            if (!s.panel) return
            s.panel.phase = 'idle'
            s.panel.error = err instanceof Error ? err.message : String(err)
          })
        }
      },

      toggleSelected: (path) => {
        set((s) => {
          if (!s.panel) return
          if (s.panel.selected[path]) delete s.panel.selected[path]
          else s.panel.selected[path] = true
        })
      },

      setFieldDisposition: (id, disposition) => {
        set((s) => {
          if (!s.panel?.fieldReview) return
          s.panel.fieldReview.decisions[id] = disposition
        })
      },

      setAllFieldDispositions: (disposition) => {
        set((s) => {
          const review = s.panel?.fieldReview
          if (!review) return
          for (const f of review.changes.fields) review.decisions[f.id] = disposition
          for (const p of review.changes.papers) review.decisions[p.id] = disposition
        })
      },

      setCommitMessage: (message) => {
        set((s) => {
          if (s.panel) s.panel.message = message
        })
      },

      setAmend: async (amend) => {
        const git = getPlatform().getGit()
        const repo = get().repo
        set((s) => {
          if (s.panel) s.panel.amend = amend
        })
        if (amend && git && repo && !get().panel?.message.trim()) {
          const last = await git.lastCommitMessage(repo.root)
          if (last) {
            set((s) => {
              if (s.panel && s.panel.amend && !s.panel.message.trim()) s.panel.message = last
            })
          }
        }
      },

      runCommit: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        const panel = get().panel
        if (!git || !repo || !panel) return

        // See `guardFieldReviewFresh`: composing from a stale review snapshot
        // would silently overwrite whatever changed on disk since it was taken.
        const review = panel.fieldReview
        if (review && !(await guardFieldReviewFresh(repo, review))) return

        // A rename contributes both its new path and its "from" path, or the
        // deletion of the old path is left behind.
        const changes = panel.status?.changes ?? []
        const otherPaths: string[] = []
        for (const p of Object.keys(panel.selected)) {
          otherPaths.push(p)
          const change = changes.find((c) => c.path === p)
          if (change?.from) otherPaths.push(change.from)
        }

        set((s) => {
          if (s.panel) {
            s.panel.phase = 'working'
            s.panel.error = null
            s.panel.notice = null
          }
        })

        let r: GitRun
        let usedFieldReview = false
        if (review) {
          const { committed, workingOut } = composeContents(review.head, review.working, review.changes, review.decisions)
          r = await git.commitPartial(
            repo.root,
            repo.relPath,
            toSplitProject(committed),
            toSplitProject(workingOut),
            otherPaths,
            panel.message,
            panel.amend,
          )
          usedFieldReview = true
        } else {
          r = await git.commit(repo.root, otherPaths, panel.message, panel.amend)
        }

        if (!r.ok) {
          set((s) => {
            if (s.panel) {
              s.panel.phase = 'idle'
              s.panel.error = gitErrorText(r)
            }
          })
          return
        }

        // A "discard" decision rewrites the working file, so re-read it from
        // disk — via the lightweight resync, not `reloadOpenProject` (which
        // would reset the whole view), since this is the reviewer's own
        // rewrite, not a different project loading. `dirty` is guaranteed
        // false here (Commit is disabled otherwise), so nothing unsaved is lost.
        if (usedFieldReview) await useStore.getState().resyncProjectFromDisk()

        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.message = ''
            s.panel.amend = false
            s.panel.notice = panel.amend ? 'Amended.' : 'Committed.'
          }
        })
        await get().refreshStatus()
        // A commit can change who last wrote a seat — most obviously the first
        // one, which turns an unclaimed seat into yours.
        await get().refreshSeatOwners()
      },

      runDiscard: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        const panel = get().panel
        if (!git || !repo || !panel) return
        const review = panel.fieldReview
        if (!review) return
        // Nothing marked to discard is nothing to do — the button is disabled
        // in that state, this is the belt-and-suspenders match.
        const hasDiscard = Object.values(review.decisions).some((d) => d === 'discard')
        if (!hasDiscard) return

        // See `guardFieldReviewFresh`: composing from a stale review snapshot
        // would silently overwrite whatever changed on disk since it was taken.
        if (!(await guardFieldReviewFresh(repo, review))) return

        set((s) => {
          if (s.panel) {
            s.panel.phase = 'working'
            s.panel.error = null
            s.panel.notice = null
          }
        })

        // Exactly the `workingOut` a commit-with-these-decisions would have
        // left behind — the same compose path, so the two can never drift.
        const { workingOut } = composeContents(review.head, review.working, review.changes, review.decisions)
        const r = await git.writeWorking(repo.root, repo.relPath, toSplitProject(workingOut))
        if (!r.ok) {
          set((s) => {
            if (s.panel) {
              s.panel.phase = 'idle'
              s.panel.error = gitErrorText(r)
            }
          })
          return
        }

        // Same resync as `runCommit`'s field path, for the same reason: this
        // is the reviewer's own rewrite, not a different project loading, so
        // the view must stay put. `dirty` is guaranteed false here.
        await useStore.getState().resyncProjectFromDisk()
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.notice = 'Reverted the discarded changes. Nothing was committed.'
          }
        })
        await get().refreshStatus()
      },

      runPush: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo) return
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'working'
            s.panel.error = null
            s.panel.notice = null
          }
        })
        const r = await git.push(repo.root)
        set((s) => {
          if (!s.panel) return
          s.panel.phase = 'idle'
          if (r.ok) s.panel.notice = 'Pushed.'
          else s.panel.error = gitErrorText(r)
        })
      },

      runPull: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo) return

        if (!guardDirtyForMerge('pulling')) return

        set((s) => {
          if (s.panel) {
            s.panel.phase = 'working'
            s.panel.error = null
            s.panel.notice = null
          }
        })

        const start = await git.beginPull(repo.root, repo.relPath)
        if (start.kind === 'no-upstream') {
          set((s) => {
            if (s.panel) {
              s.panel.phase = 'idle'
              s.panel.error = `The branch ${start.branch ?? '(detached HEAD)'} has no upstream branch, so there is nothing to pull from.`
            }
          })
          return
        }
        await applyMergeStart(start, { kind: 'pull' }, repo.upstream ?? 'the remote')
      },

      runMergeBranch: async (ref) => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo || ref === repo.branch) return

        if (!guardDirtyForMerge('merging')) return

        set((s) => {
          if (s.panel) {
            s.panel.phase = 'working'
            s.panel.error = null
            s.panel.notice = null
          }
        })

        const start = await git.beginMerge(repo.root, repo.relPath, ref)
        await applyMergeStart(start, { kind: 'merge-branch' }, ref)
      },

      openMergeBranchPrompt: () => {
        const repo = get().repo
        const first = get()
          .branches.filter((b) => !b.current)
          .find((b) => b.name !== repo?.branch)?.name
        if (!first) return
        set((s) => {
          if (s.panel) s.panel.mergeBranchPrompt = { branch: first }
        })
      },

      setMergeBranchPromptBranch: (branch) => {
        set((s) => {
          if (s.panel?.mergeBranchPrompt) s.panel.mergeBranchPrompt.branch = branch
        })
      },

      closeMergeBranchPrompt: () => {
        set((s) => {
          if (s.panel) s.panel.mergeBranchPrompt = null
        })
      },

      confirmMergeBranchPrompt: async () => {
        const branch = get().panel?.mergeBranchPrompt?.branch
        set((s) => {
          if (s.panel) s.panel.mergeBranchPrompt = null
        })
        if (!branch) return
        await get().runMergeBranch(branch)
      },

      openDeleteBranchPrompt: () => {
        const first = get()
          .branches.filter((b) => !b.current && !b.remote)
          .find(Boolean)?.name
        if (!first) return
        set((s) => {
          if (s.panel) s.panel.deleteBranchPrompt = { branch: first }
        })
      },

      setDeleteBranchPromptBranch: (branch) => {
        set((s) => {
          if (s.panel?.deleteBranchPrompt) s.panel.deleteBranchPrompt.branch = branch
        })
      },

      closeDeleteBranchPrompt: () => {
        set((s) => {
          if (s.panel) s.panel.deleteBranchPrompt = null
        })
      },

      confirmDeleteBranchPrompt: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        const branch = get().panel?.deleteBranchPrompt?.branch
        set((s) => {
          if (s.panel) s.panel.deleteBranchPrompt = null
        })
        if (!git || !repo || !branch) return
        const r = await git.deleteBranch(repo.root, branch)
        if (!r.ok) {
          set((s) => {
            if (s.panel) s.panel.error = gitErrorText(r)
          })
          return
        }
        await get().refreshBranches()
        set((s) => {
          if (s.panel) s.panel.notice = `Deleted ${branch}.`
        })
      },

      openHistory: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo) return
        set((s) => {
          if (s.panel) s.panel.history = { commits: [], truncated: false, error: null, diffs: {} }
        })
        const result = await git.logBegin(repo.root, repo.relPath)
        set((s) => {
          if (!s.panel?.history) return
          s.panel.history.commits = result.commits
          s.panel.history.truncated = result.truncated
          s.panel.history.error = result.error
        })
      },

      closeHistory: () => {
        set((s) => {
          if (s.panel) s.panel.history = null
        })
      },

      loadCommitDiff: async (hash) => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo) return
        if (get().panel?.history?.diffs[hash] !== undefined) return // fetched or already in flight

        set((s) => {
          if (s.panel?.history) s.panel.history.diffs[hash] = 'loading'
        })

        const fetch = await git.logDiff(repo.root, repo.relPath, hash)
        let result: LogDiffResult
        if (fetch.kind === 'initial' || fetch.kind === 'error') {
          result = fetch
        } else {
          try {
            const head = loadProject(fetch.head)
            const parent = loadProject(fetch.parent)
            const changes = detectFieldChanges(parent, head)
            result = changes ? { kind: 'changes', changes } : { kind: 'structural' }
          } catch {
            result = { kind: 'structural' }
          }
        }
        set((s) => {
          if (s.panel?.history) s.panel.history.diffs[hash] = result
        })
      },

      runDiscardFile: async (path) => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo) return
        set((s) => {
          if (s.panel) s.panel.phase = 'working'
        })
        // `discardFile` itself never throws, but this `try` guards against an
        // uncaught rejection leaving `phase` stuck at 'working' (how the
        // untracked-directory bug once wedged the whole panel).
        let r: GitRun
        try {
          r = await git.discardFile(repo.root, path, repo.relPath)
        } catch (err) {
          set((s) => {
            if (s.panel) {
              s.panel.phase = 'idle'
              s.panel.error = err instanceof Error ? err.message : String(err)
            }
          })
          return
        }
        set((s) => {
          if (!s.panel) return
          s.panel.phase = 'idle'
          if (r.ok) delete s.panel.selected[path]
          else s.panel.error = gitErrorText(r)
        })
        if (r.ok) await get().refreshStatus()
      },

      dismissPanelMessage: () => {
        set((s) => {
          if (s.panel) {
            s.panel.error = null
            s.panel.notice = null
          }
        })
      },

      resolveConflict: (id, value) => {
        set((s) => {
          if (!s.panel?.merge) return
          s.panel.merge.resolutions[id] = value
          s.panel.merge.decided[id] = true
        })
      },

      takeSide: (id, side) => {
        const merge = get().panel?.merge
        const conflict = merge?.conflicts.find((c) => c.id === id)
        if (!conflict) return
        get().resolveConflict(id, side === 'ours' ? conflict.ours : conflict.theirs)
      },

      takeAll: (side, ids) => {
        const scope = ids ? new Set(ids) : null
        set((s) => {
          const merge = s.panel?.merge
          if (!merge) return
          for (const c of merge.conflicts) {
            if (scope && !scope.has(c.id)) continue
            merge.resolutions[c.id] = side === 'ours' ? c.ours : c.theirs
            merge.decided[c.id] = true
          }
        })
      },

      finishMerge: async () => {
        const merge = get().panel?.merge
        if (!merge) return
        await doFinish(merge.source, merge.ref, merge.merged, merge.conflicts, merge.resolutions, merge.notes)
      },

      cancelMerge: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        const merge = get().panel?.merge
        if (!git || !repo || !merge) return
        const r =
          merge.source.kind === 'branch-switch'
            ? await git.abortBranchSwitch(repo.root, merge.source.sourceBranch)
            : await git.abortPull(repo.root)
        if (!r.ok) {
          set((s) => {
            if (s.panel) s.panel.error = gitErrorText(r)
          })
          return
        }
        set((s) => {
          if (s.panel) {
            s.panel.merge = null
            s.panel.notice = 'The merge was aborted. Nothing changed.'
          }
        })
        if (merge.source.kind === 'branch-switch') {
          await get().refreshRepo(useStore.getState().saveHandle)
          await get().refreshBranches()
          await get().refreshStatus()
        }
      },

      refreshBranches: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo) {
          set((s) => {
            s.branches = []
          })
          return
        }
        const branches = await git.branches(repo.root)
        set((s) => {
          s.branches = branches
        })
      },

      requestSwitchBranch: (branch) => {
        const repo = get().repo
        if (!repo || branch === repo.branch) return

        // A clean checkout reloads the project from disk, so the same guard
        // applies here as to a merge.
        if (!guardDirtyForMerge('switching branches')) return
        const dirty = (get().panel?.status?.changes.length ?? 0) > 0
        if (!dirty) {
          void runCleanCheckout(branch)
          return
        }
        set((s) => {
          if (s.panel) s.panel.branchSwitchPrompt = { branch }
        })
      },

      resolveBranchSwitchPrompt: async (choice) => {
        const branch = get().panel?.branchSwitchPrompt?.branch
        set((s) => {
          if (s.panel) s.panel.branchSwitchPrompt = null
        })
        if (!branch || choice !== 'carryOver') return
        await runBranchSwitchCarryOver(branch)
      },

      openNewBranchPrompt: () => {
        set((s) => {
          if (s.panel) s.panel.newBranchPrompt = { name: '', error: null }
        })
      },

      setNewBranchName: (name) => {
        set((s) => {
          if (s.panel?.newBranchPrompt) {
            s.panel.newBranchPrompt.name = name
            s.panel.newBranchPrompt.error = null
          }
        })
      },

      closeNewBranchPrompt: () => {
        set((s) => {
          if (s.panel) s.panel.newBranchPrompt = null
        })
      },

      createAndSwitchBranch: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        const name = get().panel?.newBranchPrompt?.name.trim() ?? ''
        if (!git || !repo) return
        if (!name) {
          set((s) => {
            if (s.panel?.newBranchPrompt) s.panel.newBranchPrompt.error = 'Enter a branch name.'
          })
          return
        }
        const r = await git.createBranch(repo.root, name)
        if (!r.ok) {
          set((s) => {
            if (s.panel?.newBranchPrompt) s.panel.newBranchPrompt.error = gitErrorText(r)
          })
          return
        }
        set((s) => {
          if (s.panel) s.panel.newBranchPrompt = null
        })
        await get().refreshBranches()
        get().requestSwitchBranch(name)
      },
    }

    /** A plain checkout — nothing in the project is uncommitted, so there is
     *  nothing to merge or lose. */
    async function runCleanCheckout(branch: string): Promise<void> {
      const git = getPlatform().getGit()
      const repo = get().repo
      if (!git || !repo) return
      set((s) => {
        if (s.panel) {
          s.panel.phase = 'working'
          s.panel.error = null
          s.panel.notice = null
        }
      })
      const r = await git.checkoutBranch(repo.root, branch)
      if (!r.ok) {
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.error = gitErrorText(r)
          }
        })
        return
      }
      await reloadOpenProject()
      set((s) => {
        if (s.panel) {
          s.panel.phase = 'idle'
          s.panel.notice = `Switched to ${branch}.`
        }
      })
      await get().refreshRepo(useStore.getState().saveHandle)
      await get().refreshBranches()
      await get().refreshStatus()
    }

    /**
     * Carries uncommitted project changes into `branch`. Mirrors `runPull`'s
     * merge handling — differs only in where the revisions/mutation come from
     * (`beginBranchSwitch`, not `git merge`).
     */
    async function runBranchSwitchCarryOver(branch: string): Promise<void> {
      const git = getPlatform().getGit()
      const repo = get().repo
      if (!git || !repo) return

      set((s) => {
        if (s.panel) {
          s.panel.phase = 'working'
          s.panel.error = null
          s.panel.notice = null
        }
      })

      const start = await git.beginBranchSwitch(repo.root, repo.relPath, branch)

      if (start.kind === 'no-changes') {
        set((s) => {
          if (s.panel) s.panel.phase = 'idle'
        })
        await runCleanCheckout(branch)
        return
      }
      if (start.kind === 'other-files-dirty') {
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.error =
              `These files are also uncommitted and aren't part of the project: ${start.paths.join(', ')}. ` +
              'SaiLoR only knows how to carry the project\'s own changes across a branch switch — ' +
              'commit or discard those first.'
          }
        })
        return
      }
      if (start.kind === 'error') {
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.error = start.message
          }
        })
        return
      }

      // start.kind === 'merge': stash + checkout already happened — parse each
      // revision independently so a failure names which one, aborting back
      // to `start.sourceBranch` like `runPull` aborts its in-progress merge.
      // Returns what to append to the caller's own error: nothing when the
      // changes came back, and otherwise git's reason plus where they went.
      // Each caller then writes its error, so a failure reported any other way
      // would be overwritten — which is exactly how a stranded carry-over used
      // to go unmentioned while the panel looked clean.
      const abort = async (): Promise<string> => {
        const r = await git.abortBranchSwitch(repo.root, start.sourceBranch)
        await get().refreshRepo(useStore.getState().saveHandle)
        await get().refreshBranches()
        await get().refreshStatus()
        return r.ok ? '' : `\n\n${gitErrorText(r)}`
      }
      let base: Project | null
      try {
        base = start.base === null ? null : loadProject(start.base)
      } catch (err) {
        const stranded = await abort()
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.error = mergeParseError(`${start.sourceBranch} (before switching)`, err) + stranded
          }
        })
        return
      }
      let ours: Project
      try {
        ours = loadProject(start.ours)
      } catch (err) {
        const stranded = await abort()
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.error = mergeParseError('your uncommitted changes', err) + stranded
          }
        })
        return
      }
      let theirs: Project
      try {
        theirs = loadProject(start.theirs)
      } catch (err) {
        const stranded = await abort()
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.error = mergeParseError(branch, err) + stranded
          }
        })
        return
      }

      const outcome = mergeProjects(base, ours, theirs)
      if (outcome.kind === 'refused') {
        const stranded = await abort()
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.error = [outcome.reason, ...outcome.details].join('\n') + stranded
          }
        })
        return
      }

      const source: MergeSource = { kind: 'branch-switch', sourceBranch: start.sourceBranch }

      if (outcome.conflicts.length === 0) {
        set((s) => {
          if (s.panel) s.panel.phase = 'idle'
        })
        await doFinish(source, branch, outcome.merged, outcome.conflicts, {}, outcome.notes)
        return
      }

      set((s) => {
        if (s.panel) {
          s.panel.phase = 'idle'
          s.panel.merge = {
            source,
            ref: branch,
            merged: outcome.merged,
            conflicts: outcome.conflicts,
            resolutions: {},
            decided: {},
            notes: outcome.notes,
          }
        }
      })
    }

    return storeApi
  }),
)
