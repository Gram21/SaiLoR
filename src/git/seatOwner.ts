/**
 * Which human has been writing a given reviewer seat.
 *
 * A seat is a purely local choice (`localStorage`, keyed by the project's
 * path — see `reviewerStorageKey` in `state/store.ts`), never recorded in the
 * project itself. Nothing therefore stopped two people from both picking
 * "Reviewer 1": they write the same `annotations/<paperId>/reviewer-1.json`,
 * and whoever merges last silently overwrites or field-merges away the
 * other's answers. That defeats the one guarantee a multi-reviewer review
 * exists to provide — that the seats were filled in independently.
 *
 * Rather than stamp an identity into the annotation files (a new field in
 * every file, repeated per paper, and a merge conflict of its own), this reads
 * the claim already recorded in the repository: who last committed that seat's
 * files. It needs no new data, works on projects that already exist, and is
 * ground truth about who has actually been writing the seat.
 *
 * Pure so it can be tested — `electron/` sits outside vitest's scope, same
 * reasoning as `deriveGitInfo`/`ownAnnotationPath`.
 */

export interface SeatOwners {
  /** This machine's git identity, or null when none is configured. */
  me: GitIdentity | null
  /** Last author of each requested seat's files; null for a seat no commit
   *  has ever touched. */
  seats: Record<string, GitIdentity | null>
}

export interface GitIdentity {
  name: string
  email: string
}

/** The seat key Consolidation uses, matching `currentReviewer` in the store. */
export const CONSOLIDATION_SEAT = 'consolidation'

/**
 * The pathspec matching every file a seat writes, across all papers. `:(glob)`
 * so `*` stops at a path separator and cannot reach into a nested directory.
 * Marks files are deliberately left out: a highlight is a reading note, and
 * someone skimming a colleague's seat would otherwise look like its owner.
 */
export function seatPathspec(dir: string, seat: string, screening: boolean): string {
  const name =
    seat === CONSOLIDATION_SEAT
      ? screening
        ? 'screening-consolidated'
        : 'consolidated'
      : `${screening ? 'screening' : 'reviewer'}-${seat}`
  return `:(glob)${dir}/*/${name}.json`
}

/** Parse `git log -1 --format=%an%x00%ae`. Empty output means no commit has
 *  ever touched the seat — an unclaimed seat, not an error. */
export function parseSeatAuthor(stdout: string): GitIdentity | null {
  const [name, email] = stdout.trim().split('\0')
  if (!name && !email) return null
  return { name: name ?? '', email: email ?? '' }
}

/**
 * The same person? Email decides when both sides have one — it is what git
 * itself keys an author on, and it survives the display name being spelled
 * differently on a second machine. Falling back to the name covers a
 * repository whose commits carry no email at all.
 */
export function sameIdentity(a: GitIdentity | null, b: GitIdentity | null): boolean {
  if (!a || !b) return false
  if (a.email && b.email) return a.email.trim().toLowerCase() === b.email.trim().toLowerCase()
  return a.name.trim() !== '' && a.name.trim() === b.name.trim()
}

/** How to name a seat's owner in the picker. The email is the fallback for a
 *  repository configured with `user.email` but no `user.name`. */
export function ownerLabel(id: GitIdentity): string {
  return id.name.trim() || id.email.trim() || 'someone else'
}

/**
 * Is `seat` one somebody other than this machine has been committing? The
 * question both places that let a reviewer take a seat have to ask — the
 * opening picker and the toolbar's switcher — so the rule lives here rather
 * than in whichever of them happened to grow it first.
 *
 * Returns the other person, or null when the seat is free to take: an
 * unclaimed seat, a project outside git, and a machine with no identity
 * configured all read as uncontested, so nothing gets in the way.
 */
export function heldByOther(owners: SeatOwners | null, seat: string): GitIdentity | null {
  const owner = owners?.seats[seat] ?? null
  if (!owner) return null
  return sameIdentity(owner, owners?.me ?? null) ? null : owner
}
