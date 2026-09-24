import type { GitRun } from './types'
import { parsePorcelain, gitErrorText } from './output'
import { ownAnnotationPathsIn } from './ownAnnotationPath'
import { annotationsRelDir, mergeBlockingPaths } from './relpath'
import { annotationsDirOf } from '../model/annotationsDir'
import { parseStashList, STASH_LIST_FORMAT, MANUAL_STASH_PREFIX, type StashEntry } from './stash'

/**
 * The stash operations behind the Git panel, written against an injected git
 * runner so the exact sequence the app runs can be exercised against a real
 * repository in the integration suite — `electron/main.ts` only binds `root`.
 *
 * Restoring is the operation worth that care. `git stash apply` is not atomic:
 * when the parked changes no longer fit the commit they are applied onto, git
 * applies what it can, leaves the rest conflicted, and keeps the stash — a
 * half-restored tree full of conflict markers, which for annotation JSON means
 * files SaiLoR cannot even read. So a restore here is all-or-nothing: it runs
 * only onto a clean tree, and if the stash does not apply cleanly it puts the
 * tree back exactly as it was and says so. The escape hatch for that case is
 * {@link branchFromStash}, which cannot conflict, after which SaiLoR's own
 * field-level merge takes over.
 */

export type RunGit = (args: string[]) => Promise<GitRun>

function failed(stderr: string): GitRun {
  return { ok: false, code: null, stdout: '', stderr }
}

export async function listStashes(run: RunGit): Promise<StashEntry[]> {
  const r = await run(['stash', 'list', `--format=${STASH_LIST_FORMAT}`])
  return r.ok ? parseStashList(r.stdout) : []
}

/** The stash's *current* `stash@{n}`, or null once it no longer exists. */
export async function resolveStashRef(run: RunGit, sha: string): Promise<string | null> {
  return (await listStashes(run)).find((e) => e.sha === sha)?.ref ?? null
}

/**
 * Stash this project's own uncommitted changes — never anyone else's.
 *
 * Scoped the same way commit staging is (see `ownAnnotationPathsIn`), because
 * a folder shared with a sibling project is exactly where a blanket
 * `git stash -u` would quietly take somebody else's work along. `-u`, because
 * a reviewer's first reading of a paper is a new file, and stashing without it
 * would leave that behind — the one change most worth parking.
 *
 * `raw` is the parsed project file, for knowing which papers are this
 * project's.
 */
export async function pushStash(run: RunGit, relPath: string, raw: unknown, message: string): Promise<GitRun> {
  const st = await run(['status', '--porcelain=v1', '-z', '-uall'])
  if (!st.ok) return st
  const changes = parsePorcelain(st.stdout)
  const paths = [
    ...changes.filter((c) => c.path === relPath).map((c) => c.path),
    ...ownAnnotationPathsIn(changes, annotationsRelDir(relPath, annotationsDirOf(raw)), raw),
  ]
  if (paths.length === 0) return failed('There are no uncommitted changes to this project to stash.')
  const note = message.trim() || 'stashed from SaiLoR'
  return run(['stash', 'push', '-u', '-m', `${MANUAL_STASH_PREFIX}${note}`, '--', ...paths])
}

export type StashRestoreResult =
  | { kind: 'restored' }
  /** Applied, but the entry could not be removed afterwards — it now
   *  duplicates what is in the tree, and deleting it is safe. */
  | { kind: 'restored-kept'; message: string }
  /** Something is uncommitted, so restoring would mix two sets of edits. Nothing done. */
  | { kind: 'dirty'; paths: string[] }
  /** Did not apply cleanly onto this commit. The tree is back as it was; the stash is kept. */
  | { kind: 'conflict' }
  | { kind: 'gone' }
  | { kind: 'error'; message: string }

/**
 * Put a stash back and remove it — all or nothing (see the module comment).
 *
 * "Clean" is the rule a merge already uses (`mergeBlockingPaths`): no tracked
 * change anywhere, and nothing untracked in the annotations folder. That
 * precondition is what makes the rollback safe: with no tracked work in the
 * tree to begin with, anything tracked that differs after a failed apply is
 * the apply's own doing, and undoing it cannot touch anybody's edits.
 */
/** `annotationsDir` is the project's annotations folder, repo-relative; the
 *  default folder when omitted. */
export async function restoreStash(
  run: RunGit,
  relPath: string,
  sha: string,
  annotationsDir: string = annotationsRelDir(relPath),
): Promise<StashRestoreResult> {
  const ref = await resolveStashRef(run, sha)
  if (!ref) return { kind: 'gone' }

  const st = await run(['status', '--porcelain=v1', '-z', '-uall'])
  if (!st.ok) return { kind: 'error', message: gitErrorText(st) }
  const blocking = mergeBlockingPaths(parsePorcelain(st.stdout), annotationsDir)
  if (blocking.length > 0) return { kind: 'dirty', paths: blocking }

  const apply = await run(['stash', 'apply', ref])
  if (apply.ok) {
    // Applying does not move the entry, so `ref` still names it.
    const drop = await run(['stash', 'drop', ref])
    return drop.ok ? { kind: 'restored' } : { kind: 'restored-kept', message: gitErrorText(drop) }
  }

  // A refusal before touching anything (a local file in the way, a lock)
  // leaves nothing tracked changed; a conflict leaves the half-applied state.
  const after = await run(['status', '--porcelain=v1', '-z'])
  const leftovers = after.ok ? parsePorcelain(after.stdout).filter((c) => c.code !== '??') : []
  if (leftovers.length === 0) return { kind: 'error', message: gitErrorText(apply) }

  await rollBackFailedApply(run, ref)
  return { kind: 'conflict' }
}

/**
 * Undo a stash apply that stopped half-way.
 *
 * `reset --merge` resets the index and the files that differ from HEAD while
 * keeping any change nobody staged — the gentler of git's resets, and enough
 * here because the precondition in `restoreStash` guaranteed there was none.
 * A stash made with `-u` also restored its untracked files before the tracked
 * part failed; those are exactly the files in its third parent, and since the
 * apply would have refused outright had any of them already existed, removing
 * them removes only what the apply itself created.
 */
async function rollBackFailedApply(run: RunGit, ref: string): Promise<void> {
  await run(['reset', '--merge'])
  const untracked = await run(['ls-tree', '-r', '--name-only', '-z', `${ref}^3`])
  if (!untracked.ok) return // no third parent: the stash had no untracked files
  const paths = untracked.stdout.split('\0').filter(Boolean)
  if (paths.length > 0) await run(['clean', '-f', '-q', '--', ...paths])
}

/** Delete a stash for good. */
export async function dropStash(run: RunGit, sha: string): Promise<GitRun> {
  const ref = await resolveStashRef(run, sha)
  if (!ref) return failed('That stash no longer exists.')
  return run(['stash', 'drop', ref])
}

/**
 * Restore a stash onto a new branch made at the commit it was taken from —
 * which, unlike restoring onto wherever the reviewer is now, cannot conflict.
 * git removes the stash once it has applied. From there the reviewer commits,
 * switches back, and uses Merge branch…, where SaiLoR resolves any overlap
 * field by field instead of leaving conflict markers in annotation files.
 *
 * Same cleanliness rule as {@link restoreStash}: this checks out another
 * commit, and would refuse anyway over uncommitted tracked changes.
 */
export async function branchFromStash(
  run: RunGit,
  relPath: string,
  sha: string,
  branch: string,
  annotationsDir: string = annotationsRelDir(relPath),
): Promise<GitRun> {
  const ref = await resolveStashRef(run, sha)
  if (!ref) return failed('That stash no longer exists.')
  const st = await run(['status', '--porcelain=v1', '-z', '-uall'])
  if (!st.ok) return st
  const blocking = mergeBlockingPaths(parsePorcelain(st.stdout), annotationsDir)
  if (blocking.length > 0) {
    return failed(`Commit or stash these first, so the switch cannot mix two sets of edits:\n${blocking.join('\n')}`)
  }
  return run(['stash', 'branch', branch, ref])
}

/**
 * The branch-switch carry-over's own stash, found by its message rather than
 * by position. `stash@{0}` used to be assumed, which held only while nothing
 * else ever stashed; with stashes now made and restored from the Git panel,
 * the top entry can be somebody's parked work, and popping or dropping it by
 * mistake would restore — or delete — the wrong changes. Newest first, so this
 * finds the carry-over just pushed even when an older, stranded one sits below.
 */
async function carryOverStashRef(run: RunGit): Promise<string | null> {
  return (await listStashes(run)).find((e) => e.origin === 'branch-switch')?.ref ?? null
}

/** Put the carry-over back — the branch-switch abort and rollback. */
export async function popCarryOverStash(run: RunGit): Promise<GitRun> {
  const ref = await carryOverStashRef(run)
  if (!ref) return failed('The stash holding your changes could not be found.')
  return run(['stash', 'pop', ref])
}

/** Discard the carry-over once a finished switch has folded it in. Nothing to
 *  drop is not an error: the goal — no stray carry-over left — already holds. */
export async function dropCarryOverStash(run: RunGit): Promise<GitRun> {
  const ref = await carryOverStashRef(run)
  if (!ref) return { ok: true, code: 0, stdout: '', stderr: '' }
  return run(['stash', 'drop', ref])
}
