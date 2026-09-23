/**
 * Stashed changes, as SaiLoR shows and manages them.
 *
 * A stash is uncommitted work parked outside the working tree — and parked work
 * nobody remembers is lost work. SaiLoR already stashes on the reviewer's
 * behalf (carrying uncommitted annotations across a branch switch), and until
 * now a stash that failed to come back left no trace in the UI at all: the
 * panel looked clean while somebody's readings sat in `git stash list`, found
 * only by whoever thought to look there from a terminal. So the list is shown,
 * each entry says where it came from, and restoring one is a button.
 *
 * Entries are identified by commit sha, never by `stash@{n}`. The index is a
 * position in a reflog and shifts whenever anything else pushes or drops a
 * stash; a sha names the same stash for as long as it exists. The main process
 * resolves a sha back to its current `stash@{n}` at the moment it acts.
 *
 * Pure, and in `src/git/`, for the same reason as the rest of this folder: it
 * decides what a reviewer is told about their own parked work, and
 * `electron/` is outside vitest's scope.
 */

/** The message SaiLoR's branch-switch carry-over stashes with — see
 *  `git:branchSwitchBegin`. Recognised on the way back so such a stash can say
 *  why it exists. */
export const BRANCH_SWITCH_STASH_MESSAGE = 'sailor: switching branch'

/** Prefix for stashes a reviewer makes from the Git panel. Deliberately not a
 *  prefix of {@link BRANCH_SWITCH_STASH_MESSAGE}, so a reviewer who happens to
 *  type "switching branch" is not mistaken for the carry-over. */
export const MANUAL_STASH_PREFIX = 'sailor stash: '

export type StashOrigin = 'branch-switch' | 'sailor' | 'other'

export interface StashEntry {
  /** Stable identity — see the module comment. */
  sha: string
  /** Where it currently sits (`stash@{0}`), for display only. */
  ref: string
  /** ISO 8601, from `%cI`. */
  date: string
  /** The branch it was made on, or null when git did not record one. */
  branch: string | null
  /** The message without git's "On <branch>: " prefix. */
  message: string
  origin: StashOrigin
}

/** `git stash list --format=...` in the shape `parseStashList` reads: ref,
 *  sha, committer date, reflog subject, NUL-terminated. */
export const STASH_LIST_FORMAT = '%gd%x09%H%x09%cI%x09%gs%x00'

/**
 * Parse `git stash list` into entries, newest first (git's own order).
 *
 * The reflog subject is `On <branch>: <message>` for a named stash and
 * `WIP on <branch>: <sha> <subject>` for an unnamed one; both are unpacked so
 * the list can show branch and message separately. Defensive in the same way
 * as every parser here — a malformed record is skipped, not thrown over.
 */
export function parseStashList(stdout: string): StashEntry[] {
  const out: StashEntry[] = []
  for (const record of stdout.split('\0')) {
    const line = record.replace(/^\n+/, '')
    if (!line) continue
    const [ref, sha, date, ...rest] = line.split('\t')
    if (!ref || !sha) continue
    const subject = rest.join('\t')
    const m = /^(?:WIP on|On) ([^:]+): (.*)$/s.exec(subject)
    const branch = m ? m[1] : null
    const message = m ? m[2] : subject
    const origin: StashOrigin =
      message === BRANCH_SWITCH_STASH_MESSAGE
        ? 'branch-switch'
        : message.startsWith(MANUAL_STASH_PREFIX)
          ? 'sailor'
          : 'other'
    out.push({ sha, ref, date: date ?? '', branch, message, origin })
  }
  return out
}

/** What a reviewer should be told a stash is, in words rather than a message
 *  git wrote for itself. */
export function describeStash(entry: StashEntry): string {
  if (entry.origin === 'branch-switch') {
    return 'Saved by SaiLoR while switching branches, and not put back afterwards'
  }
  if (entry.origin === 'sailor') return entry.message.slice(MANUAL_STASH_PREFIX.length) || 'Stashed from SaiLoR'
  return entry.message
}

/** A branch name for `git stash branch`, unique against `existing`. */
export function stashBranchName(entry: StashEntry, existing: string[]): string {
  const day = entry.date.slice(0, 10) || 'stash'
  const base = `restored-stash-${day}`
  const taken = new Set(existing)
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}
