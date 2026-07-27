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
import { gitErrorText } from '../git/output'
import type { GitProbe, GitRepoInfo, GitRun, GitStatus, GitBranch } from '../git/types'
import { useStore } from './store'

/**
 * State for the git flows: importing from a repository, and the commit/pull/
 * push panel. Kept out of the main store for the same reason `aiStore` and
 * the project editor are: a self-contained mode with its own lifecycle that
 * the ordinary annotation path never needs to know about.
 *
 * Dependency direction is one-way: `gitStore` reads and drives `useStore`
 * (`useStore.getState()`), but `store.ts` never imports this module — the
 * same shape `aiStore` already has. Refreshing `repo` when the open project
 * changes is therefore an `App.tsx` effect, not a call from inside `store.ts`.
 */

interface CloneState {
  phase: 'setup' | 'cloning' | 'error' | 'done'
  url: string
  /** The folder the reviewer picked to clone *into*. */
  parent: string | null
  /** Exactly what git printed. Shown verbatim, never summarised. */
  error: string
  /** Where the repository landed, once it has. */
  dest: string | null
  /** Wall-clock start, for the elapsed-seconds line — a clone of a repo of PDFs is slow. */
  startedAt: number
}

/**
 * A field-level three-way merge in progress — either a `pull` (merging the
 * upstream ref) or a `branch-switch` (merging the target branch, carrying
 * over the reviewer's uncommitted changes). `GitMergeDialog` renders either
 * identically; only finishing and cancelling need to know which, since they
 * call different git operations (`finishPull`/`abortPull` vs
 * `finishBranchSwitch`/`abortBranchSwitch`, the latter needing `sourceBranch`
 * to check back out to on cancel).
 */
type MergeSource =
  | { kind: 'pull' }
  | { kind: 'branch-switch'; sourceBranch: string }

interface MergeState {
  source: MergeSource
  /** The other side's name — an upstream ref ("origin/main") for a pull, the
   *  target branch's own name for a branch-switch. Shown as-is, e.g. "Your
   *  changes and {ref}'s both changed these fields." reads correctly either way. */
  ref: string
  merged: Project
  conflicts: FieldConflict[]
  resolutions: Resolutions
  /** Which rows the reviewer has actually decided. A row starts pre-filled with
   *  our value so the control has something to show; that is not a decision. */
  decided: Record<string, true>
  notes: MergeNote[]
}

/**
 * Field-level review of the open project's own file, when it is a tracked
 * modification that parses as a project on both HEAD and the working tree —
 * see `refreshFieldReview`. `null` for every other case (untracked, deleted,
 * unparseable, or a structural difference `detectFieldChanges` itself
 * refuses), in which the project file falls back to the plain file-level
 * checkbox `panel.selected` already handles for every other changed file.
 */
interface FieldReviewState {
  head: Project
  working: Project
  changes: DetectedChanges
  /** Absent means 'use' — the default `composeContents` itself applies, so a
   *  reviewer who never touches a row still commits everything they changed,
   *  the same "clicking Git commits my annotations" default the plain
   *  file-level checkbox already has. */
  decisions: Record<string, Disposition>
}

/**
 * Asked whenever the reviewer picks a different branch while the project has
 * uncommitted changes — see `requestSwitchBranch`. `branch` is the target;
 * resolving with `'carryOver'` starts the merge flow (`MergeState` above),
 * `'commitFirst'`/`'cancel'` both just close this without switching anything
 * (the two exist as separate buttons purely so "I meant to commit" reads
 * differently from "never mind" — the app-side effect is identical: nothing
 * happens, the reviewer stays on their current branch to commit by hand).
 */
interface BranchSwitchPromptState {
  branch: string
}

/**
 * The "New branch…" entry in the branch switcher's own state — a name the
 * reviewer is typing, plus whatever git said the one time they tried to
 * create it (`error`, distinct from `panel.error` so a failed name doesn't
 * get lost behind the dialog it belongs to the moment something else
 * touches the shared one). Creating succeeds via a plain `git branch` at the
 * current commit; what actually switches to it afterward is the ordinary
 * `requestSwitchBranch` flow, run exactly as if the reviewer had picked an
 * existing branch — a freshly cut branch shares its parent's commit, so
 * that switch can never itself conflict.
 */
interface NewBranchPromptState {
  name: string
  error: string | null
}

interface PanelState {
  phase: 'idle' | 'loading' | 'working'
  status: GitStatus | null
  message: string
  /** Paths ticked for the next commit — every changed file *except* the open
   *  project's own, whenever `fieldReview` is handling that one instead. */
  selected: Record<string, true>
  fieldReview: FieldReviewState | null
  error: string | null
  notice: string | null
  merge: MergeState | null
  branchSwitchPrompt: BranchSwitchPromptState | null
  newBranchPrompt: NewBranchPromptState | null
}

interface GitState {
  /** null until probed once per launch. */
  probe: GitProbe | null
  /** Where the open project sits git-wise; null when it is not in a repository,
   *  there is no project, or git is unavailable. */
  repo: GitRepoInfo | null
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
  /** Every field/paper row in the current field review, at once — the same
   *  "one click covers the whole list" `GitMergeDialog`'s "Use all mine" /
   *  "Use all remote" already offers, for the analogous question here. */
  setAllFieldDispositions: (disposition: Disposition) => void
  setCommitMessage: (message: string) => void
  runCommit: () => Promise<void>
  /** Apply the field review's current 'discard' decisions to the working
   *  tree — revert those rows to HEAD's value — WITHOUT making a commit. */
  runDiscard: () => Promise<void>
  runPush: () => Promise<void>
  runPull: () => Promise<void>
  dismissPanelMessage: () => void

  resolveConflict: (id: string, value: FieldValue) => void
  takeSide: (id: string, side: 'ours' | 'theirs') => void
  /** `ids`, when given, scopes the bulk action to those conflicts only — see
   *  `GitMergeDialog`'s exclusion of other reviewers' own trees from "Use all
   *  mine"/"Use all remote". Omitted (or absent) means every conflict, the
   *  original all-of-them behavior. */
  takeAll: (side: 'ours' | 'theirs', ids?: string[]) => void
  finishMerge: () => Promise<void>
  cancelMerge: () => Promise<void>

  /**
   * The reviewer picked `branch` from the switcher. With nothing uncommitted
   * in the project, switches right away; otherwise opens the three-way
   * prompt (`branchSwitchPrompt`) — commit first (abort the switch for now),
   * carry the changes into the new branch (merging as needed), or cancel.
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
     * Shared by the zero-conflict fast path in `runPull`/`runBranchSwitchCarryOver`
     * and the merge dialog's `finishMerge`: write the resolved text, and only
     * touch `panel` once we know whether it actually succeeded. On failure the
     * repository is genuinely still mid-merge (or mid-branch-switch), so
     * `panel.merge` is left in place — Cancel merge must stay reachable.
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
        source.kind === 'pull'
          ? await git.finishPull(repo.root, repo.relPath, toSplitProject(resolved))
          : await git.finishBranchSwitch(repo.root, repo.relPath, toSplitProject(resolved))
      if (!r.ok) {
        set((s) => {
          if (s.panel) {
            s.panel.error = gitErrorText(r)
            // The repository is genuinely still mid-merge, so Cancel merge must
            // stay reachable (GitMergeDialog renders only while `panel.merge`
            // is set). The conflict path set it before getting here; the
            // zero-conflict fast path did not — so back-fill it here rather
            // than wedge a repo with a failed finish (e.g. the commit
            // rejected for an unset git user.name/email) and no in-app way
            // to abort.
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
     * Recomputes `panel.fieldReview` for the open project's own file, given
     * the `status` `refreshStatus` just fetched. Every failure mode — the
     * file isn't in `status.changes` at all, it's untracked (no HEAD
     * revision), either revision fails to parse as a project, or
     * `detectFieldChanges` itself refuses because something structural
     * changed — lands on `null`, which is exactly what makes the project
     * file fall back to the plain file-level checkbox: nothing here ever
     * surfaces as an *error*, since "can't review this one field by field"
     * is routine, not exceptional.
     *
     * Existing decisions survive a refresh that leaves the same fields
     * changed (an incidental ↻ click must not silently reset a reviewer's
     * careful per-row choices) and are dropped for any id no longer present.
     */
    async function refreshFieldReview(repo: GitRepoInfo, status: GitStatus): Promise<void> {
      const git = getPlatform().getGit()
      if (!git) return

      // A change under `annotations/` counts too, not just `project.json`
      // itself — most day-to-day edits are exactly that now that annotations
      // live in their own per-paper-per-reviewer files. Unlike `relPath`
      // itself, an untracked ('??') annotation file still counts: a reviewer
      // answering a paper for the first time creates a brand-new file while
      // `project.json` stays clean, and that is the routine case field
      // review exists for — `readProjectAtRevision` already treats "no such
      // file at HEAD" as an absent (empty) tree, so the new answer surfaces
      // as an ordinary changed field. `relPath` itself being untracked means
      // the whole project has never been committed at all, which field
      // review has nothing to diff against — that case is still skipped.
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

    const storeApi: GitState = {
      probe: null,
      repo: null,
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
        })
        const git = getPlatform().getGit()
        if (!git || !handle?.path) return
        const info = await git.info(handle.path)
        // The open project may have changed again while this was in flight.
        if (useStore.getState().saveHandle?.path !== handle.path) return
        set((s) => {
          s.repo = info
        })
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
        // `requestOpenRecent`, not `openRecent`: opening the clone replaces
        // whatever project is on screen, discarding its unsaved changes exactly
        // as Ctrl+O would. This button is reachable from the toolbar with a
        // dirty project open, so it has to go through the same prompt.
        useStore.getState().requestOpenRecent(p)
        // Only dismiss the clone panel once the open has actually happened.
        // `requestOpenRecent` opens immediately when nothing is dirty, but
        // otherwise only queues the intent behind the save prompt — and
        // cancelling that prompt, or a save that fails, drops the intent. If
        // the panel were already gone, the reviewer would be left with no
        // project opened and no way back to the clone they just made.
        if (!useStore.getState().pendingAfterPrompt) get().closeClone()
      },

      openPanel: async () => {
        set((s) => {
          s.panel = {
            phase: 'idle',
            status: null,
            message: '',
            selected: {},
            fieldReview: null,
            error: null,
            notice: null,
            merge: null,
            branchSwitchPrompt: null,
            newBranchPrompt: null,
          }
        })
        await get().refreshStatus()
        await get().refreshBranches()
        // Default tick: only the open project's own file, when it is in the
        // list *and* not already being handled by field-level review below.
        // Clicking Git means "my annotations", not whatever else is lying
        // around the repo — everything else is one visible tick away.
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

      runCommit: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        const panel = get().panel
        if (!git || !repo || !panel) return
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

        const review = panel.fieldReview
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
          )
          usedFieldReview = true
        } else {
          r = await git.commit(repo.root, otherPaths, panel.message)
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

        // A field-level commit may have rewritten the working file (any
        // "discard" decision does), so the app's in-memory project — if this
        // is the file currently open — has to be re-read from disk, the same
        // reason a finished pull always does. `dirty` is guaranteed false
        // here: the Commit button is disabled while it isn't, precisely so
        // this reload can never discard unsaved work.
        if (usedFieldReview) await reloadOpenProject()

        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.message = ''
            s.panel.notice = 'Committed.'
          }
        })
        await get().refreshStatus()
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

        // The working file was rewritten, so the in-memory project has to be
        // re-read from disk — the same reason `runCommit`'s field path
        // reloads. `dirty` is guaranteed false: the Discard button is
        // disabled while it isn't, so this reload can never drop unsaved work.
        await reloadOpenProject()
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

        // The single most important guard in this store: `git status` sees
        // the file on disk, not the reviewer's unsaved annotations in memory.
        // A fast-forward or a finished merge reloads the file from disk —
        // without this check that would silently discard unsaved work.
        if (useStore.getState().dirty) {
          set((s) => {
            if (s.panel) {
              s.panel.error =
                'Save the project first — pulling works on the file on disk, and your unsaved ' +
                'annotations would be lost.'
            }
          })
          return
        }

        set((s) => {
          if (s.panel) {
            s.panel.phase = 'working'
            s.panel.error = null
            s.panel.notice = null
          }
        })

        const start = await git.beginPull(repo.root, repo.relPath)

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
              s.panel.notice = `Updated to ${repo.upstream ?? 'the remote'}.`
            }
          })
          await get().refreshStatus()
          return
        }
        if (start.kind === 'dirty') {
          set((s) => {
            if (s.panel) {
              s.panel.phase = 'idle'
              s.panel.error = `This repository has uncommitted changes: ${start.paths.join(', ')}. Commit them first.`
            }
          })
          return
        }
        if (start.kind === 'no-upstream') {
          set((s) => {
            if (s.panel) {
              s.panel.phase = 'idle'
              s.panel.error = `The branch ${start.branch ?? '(detached HEAD)'} has no upstream branch, so there is nothing to pull from.`
            }
          })
          return
        }
        if (start.kind === 'conflict-elsewhere') {
          set((s) => {
            if (s.panel) {
              s.panel.phase = 'idle'
              s.panel.error =
                `Git could not merge these files on its own: ${start.paths.join(', ')}. SaiLoR only ` +
                'knows how to merge the project JSON — resolve these with git and pull again. The ' +
                'merge has been aborted; nothing changed.'
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

        // start.kind === 'merge': parse each revision independently, so a
        // parse failure names exactly which one is unreadable.
        let base: Project | null
        try {
          base = start.base === null ? null : loadProject(start.base)
        } catch (err) {
          await git.abortPull(repo.root)
          set((s) => {
            if (s.panel) {
              s.panel.phase = 'idle'
              s.panel.error = mergeParseError('the merge base', err)
            }
          })
          return
        }
        let ours: Project
        try {
          ours = loadProject(start.ours)
        } catch (err) {
          await git.abortPull(repo.root)
          set((s) => {
            if (s.panel) {
              s.panel.phase = 'idle'
              s.panel.error = mergeParseError('HEAD (your copy)', err)
            }
          })
          return
        }
        let theirs: Project
        try {
          theirs = loadProject(start.theirs)
        } catch (err) {
          await git.abortPull(repo.root)
          set((s) => {
            if (s.panel) {
              s.panel.phase = 'idle'
              s.panel.error = mergeParseError(start.ref, err)
            }
          })
          return
        }

        const outcome = mergeProjects(base, ours, theirs)
        if (outcome.kind === 'refused') {
          await git.abortPull(repo.root)
          set((s) => {
            if (s.panel) {
              s.panel.phase = 'idle'
              s.panel.error = [outcome.reason, ...outcome.details].join('\n')
            }
          })
          return
        }

        if (outcome.conflicts.length === 0) {
          set((s) => {
            if (s.panel) s.panel.phase = 'idle'
          })
          await doFinish({ kind: 'pull' }, start.ref, outcome.merged, outcome.conflicts, {}, outcome.notes)
          return
        }

        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.merge = {
              source: { kind: 'pull' },
              ref: start.ref,
              merged: outcome.merged,
              conflicts: outcome.conflicts,
              resolutions: {},
              decided: {},
              notes: outcome.notes,
            }
          }
        })
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
          merge.source.kind === 'pull'
            ? await git.abortPull(repo.root)
            : await git.abortBranchSwitch(repo.root, merge.source.sourceBranch)
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
     * The reviewer chose to carry their uncommitted project changes into
     * `branch`. Mirrors `runPull`'s merge handling almost exactly — the only
     * real difference is where the three revisions and the mutation
     * (stash/checkout) come from (`beginBranchSwitch`, not a `git merge`).
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

      // start.kind === 'merge': the stash + checkout already happened —
      // parse each revision independently so a parse failure names exactly
      // which one is unreadable, aborting back to `start.sourceBranch` on
      // any failure the same way `runPull` aborts its in-progress merge.
      const abort = async () => {
        await git.abortBranchSwitch(repo.root, start.sourceBranch)
        await get().refreshRepo(useStore.getState().saveHandle)
        await get().refreshBranches()
        await get().refreshStatus()
      }
      let base: Project | null
      try {
        base = start.base === null ? null : loadProject(start.base)
      } catch (err) {
        await abort()
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.error = mergeParseError(`${start.sourceBranch} (before switching)`, err)
          }
        })
        return
      }
      let ours: Project
      try {
        ours = loadProject(start.ours)
      } catch (err) {
        await abort()
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.error = mergeParseError('your uncommitted changes', err)
          }
        })
        return
      }
      let theirs: Project
      try {
        theirs = loadProject(start.theirs)
      } catch (err) {
        await abort()
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.error = mergeParseError(branch, err)
          }
        })
        return
      }

      const outcome = mergeProjects(base, ours, theirs)
      if (outcome.kind === 'refused') {
        await abort()
        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.error = [outcome.reason, ...outcome.details].join('\n')
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
