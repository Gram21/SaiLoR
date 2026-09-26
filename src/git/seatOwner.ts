/**
 * Which human last committed a given reviewer seat **on a given paper**.
 *
 * A seat is a purely local choice (`localStorage`, keyed by the project's
 * path — see `reviewerStorageKey` in `state/store.ts`), never recorded in the
 * project itself. Nothing therefore stops two people from both annotating the
 * same paper in seat 1: they write the same
 * `annotations/<paperId>/reviewer-1.json`, and whoever merges last silently
 * overwrites or field-merges away the other's answers. That defeats the one
 * guarantee a multi-reviewer review exists to provide — that the two readings
 * of a paper were arrived at independently.
 *
 * **Per paper, deliberately.** A seat is not a person. The way large reviews
 * actually run is a fixed seat count (usually two readings per paper) with the
 * papers divided among many more people than seats: six reviewers over sixty
 * papers, each taking twenty of them, on seat 1 or seat 2 as it falls out. So
 * "who owns seat 1" has no answer project-wide — asking it globally names
 * whoever committed most recently anywhere and would warn every reviewer off
 * their own legitimate papers. The question with a real answer is "who has
 * already read *this* paper in *this* seat", and that is the collision worth
 * refusing to walk into.
 *
 * Rather than stamp an identity into the annotation files (a new field in
 * every file, repeated per paper, and a merge conflict of its own), this reads
 * the claim already recorded in the repository: who last committed each file.
 * It needs no new data, works on projects that already exist, and is ground
 * truth about who has actually been writing.
 *
 * Pure so it can be tested — `electron/` sits outside vitest's scope, same
 * reasoning as `deriveGitInfo`/`ownAnnotationPath`.
 */

export interface GitIdentity {
  name: string
  email: string
}

/** Last author of each annotation file, keyed by its path relative to the
 *  `annotations/` folder (`"p1/reviewer-2.json"`), plus who this machine
 *  commits as. A file no commit has touched is simply absent. */
export interface AnnotationAuthors {
  me: GitIdentity | null
  files: Record<string, GitIdentity>
}

/** The seat key Consolidation uses, matching `currentReviewer` in the store. */
export const CONSOLIDATION_SEAT = 'consolidation'

/** The file a seat writes for one paper — the same naming `splitProjectFiles`
 *  uses, and the key into {@link AnnotationAuthors.files}. */
export function seatFileFor(paperId: string, seat: string, screening: boolean): string {
  const name =
    seat === CONSOLIDATION_SEAT
      ? screening
        ? 'screening-consolidated'
        : 'consolidated'
      : `${screening ? 'screening' : 'reviewer'}-${seat}`
  return `${paperId}/${name}.json`
}

/**
 * Parse `git log --format=%x00%an%x09%ae --name-only`, newest commit first,
 * into "who last touched each path".
 *
 * One `git log` for the whole folder rather than one per seat: a review of any
 * size has far more papers than it has commits worth walking, and the first
 * occurrence of a path in a newest-first log is by definition its last author.
 * Paths arrive relative to the repository root; `dir` is stripped so the keys
 * match {@link seatFileFor}.
 */
export function parseAnnotationAuthors(stdout: string, dir: string): Record<string, GitIdentity> {
  const files: Record<string, GitIdentity> = {}
  const prefix = `${dir}/`
  // Each record is NUL, then "name<TAB>email", then a newline-separated list
  // of the paths that commit touched.
  for (const record of stdout.split('\0')) {
    const lines = record.split('\n')
    const header = lines.shift()
    if (header === undefined) continue
    const [name, email] = header.split('\t')
    if (name === undefined && email === undefined) continue
    const identity: GitIdentity = { name: name ?? '', email: email ?? '' }
    if (!identity.name && !identity.email) continue
    for (const line of lines) {
      const path = line.trim()
      if (!path.startsWith(prefix)) continue
      const rel = path.slice(prefix.length)
      // Newest-first, so the first sighting wins and later (older) commits
      // must not overwrite it.
      if (!(rel in files)) files[rel] = identity
    }
  }
  return files
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

/** How to name somebody in a warning. The email is the fallback for a
 *  repository configured with `user.email` but no `user.name`. */
export function ownerLabel(id: GitIdentity): string {
  return id.name.trim() || id.email.trim() || 'someone else'
}

/**
 * Has somebody other than this machine already read `paperId` in `seat`?
 * Returns that person, or null when the seat is free to take: nobody has
 * committed it, the project is outside git, or this machine has no identity
 * configured. Nothing known to be contested means nothing in the way.
 */
export function seatTakenByOther(
  authors: AnnotationAuthors | null,
  paperId: string,
  seat: string,
  screening: boolean,
): GitIdentity | null {
  // No identity configured means no way to tell this reviewer's own past work
  // from somebody else's — and warning people off papers they wrote themselves
  // is exactly the noise that gets a guard ignored. Say nothing instead.
  if (!authors?.me) return null
  const owner = authors.files[seatFileFor(paperId, seat, screening)]
  if (!owner) return null
  return sameIdentity(owner, authors.me) ? null : owner
}
