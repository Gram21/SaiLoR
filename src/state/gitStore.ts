import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { getPlatform } from '../platform'
import type { SaveHandle } from '../platform'
import { loadProject, serializeProject, ProjectLoadError, type Project } from '../model/project'
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
import { gitErrorText } from '../git/output'
import type { GitIdentity, GitProbe, GitRepoInfo, GitRun, GitStatus } from '../git/types'
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

interface MergeState {
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
}

interface GitState {
  /** null until probed once per launch. */
  probe: GitProbe | null
  /** Where the open project sits git-wise; null when it is not in a repository,
   *  there is no project, or git is unavailable. */
  repo: GitRepoInfo | null
  /** This machine's `git config user.email`/`user.name` for `repo` — read
   *  with the repo as cwd (not once per launch), so a reviewer with a
   *  repo-local `user.email` is answered correctly, not by whatever their
   *  global config says. `null` until `refreshRepo` has one: no repo, no
   *  project, git unavailable, or the fetch simply hasn't landed yet.
   *  `ReviewerPrompt`/`Toolbar` read this — never `store.ts`, which must not
   *  import this module (see this file's own dependency-direction note). */
  identity: GitIdentity | null
  clone: CloneState | null
  panel: PanelState | null

  probeGit: () => Promise<void>
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
  takeAll: (side: 'ours' | 'theirs') => void
  finishMerge: () => Promise<void>
  cancelMerge: () => Promise<void>
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

export const useGitStore = create<GitState>()(
  immer((set, get) => {
    /**
     * Shared by the zero-conflict fast path in `runPull` and the merge
     * dialog's `finishMerge`: write the resolved text, and only touch `panel`
     * once we know whether it actually succeeded. On failure the repository is
     * genuinely still mid-merge, so `panel.merge` is left in place — Cancel
     * merge must stay reachable.
     */
    async function doFinish(
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
      const r = await git.finishPull(repo.root, repo.relPath, serializeProject(resolved))
      if (!r.ok) {
        set((s) => {
          if (s.panel) {
            s.panel.error = gitErrorText(r)
            // The repository is genuinely still mid-merge, so Cancel merge must
            // stay reachable (GitMergeDialog renders only while `panel.merge`
            // is set). The conflict path set it before getting here; the
            // zero-conflict fast path in `runPull` did not — so back-fill it
            // here rather than wedge a repo with a failed finish (e.g. the
            // commit rejected for an unset git user.name/email) and no in-app
            // way to abort.
            if (!s.panel.merge) {
              s.panel.merge = { ref, merged, conflicts, resolutions, decided: {}, notes }
            }
          }
        })
        return
      }
      await reloadOpenProject()
      const noteText = notes.length > 0 ? ` ${notes.map((n) => n.message).join(' ')}` : ''
      set((s) => {
        if (s.panel) {
          s.panel.merge = null
          s.panel.notice = `Merged ${ref}.${noteText} Push when you are ready.`
        }
      })
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

      const inStatus = status.changes.some((c) => c.path === repo.relPath && c.code !== '??')
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

    return {
      probe: null,
      repo: null,
      identity: null,
      clone: null,
      panel: null,

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
          s.identity = null
        })
        const git = getPlatform().getGit()
        if (!git || !handle?.path) return
        const info = await git.info(handle.path)
        // The open project may have changed again while this was in flight.
        if (useStore.getState().saveHandle?.path !== handle.path) return
        set((s) => {
          s.repo = info
        })
        if (!info) return
        // A second `await`, a second chance for the project to have moved on
        // — the same guard as above, re-checked rather than assumed to still
        // hold, since this is genuinely a second race window, not the same one.
        const identity = await git.identity(info.root)
        if (useStore.getState().saveHandle?.path !== handle.path) return
        set((s) => {
          s.identity = identity
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
          }
        })
        await get().refreshStatus()
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
            serializeProject(committed),
            serializeProject(workingOut),
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
        const r = await git.writeWorking(repo.root, repo.relPath, serializeProject(workingOut))
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
          await doFinish(start.ref, outcome.merged, outcome.conflicts, {}, outcome.notes)
          return
        }

        set((s) => {
          if (s.panel) {
            s.panel.phase = 'idle'
            s.panel.merge = {
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

      takeAll: (side) => {
        set((s) => {
          const merge = s.panel?.merge
          if (!merge) return
          for (const c of merge.conflicts) {
            merge.resolutions[c.id] = side === 'ours' ? c.ours : c.theirs
            merge.decided[c.id] = true
          }
        })
      },

      finishMerge: async () => {
        const merge = get().panel?.merge
        if (!merge) return
        await doFinish(merge.ref, merge.merged, merge.conflicts, merge.resolutions, merge.notes)
      },

      cancelMerge: async () => {
        const git = getPlatform().getGit()
        const repo = get().repo
        if (!git || !repo) return
        const r = await git.abortPull(repo.root)
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
      },
    }
  }),
)
