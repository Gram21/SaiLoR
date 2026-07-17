/**
 * Who holds each reviewer seat, and whether the machine opening the project
 * agrees. Pure logic, no DOM, no store — the same shape `src/consolidate/`
 * and `src/git/merge.ts` follow, so this is unit-tested directly.
 *
 * The hazard this exists for: the seat a reviewer picks (`currentReviewer` in
 * `store.ts`) is remembered per *machine* (`localStorage`, keyed by clone
 * path), not per *project*. Two different people who both clone the same
 * repository and both pick "Reviewer 1" are invisible to each other — there
 * is nothing in the file recording who is supposed to be sitting where. Their
 * answers then merge field-by-field (`merge.ts`'s `mergePaper`) into a single
 * chimeric tree with no conflict raised, because the pre-seeded null skeleton
 * (`normalizeReviews`) makes most of it look unchanged-from-base on one side.
 *
 * `ReviewerIdentity` is the fix: a claim, recorded in the file itself
 * (`config.reviewerIdentities`), keyed by email — the one thing git already
 * gives every reviewer for free (`git config user.email`).
 */

/** A committed claim on a seat: who, by email (the comparison key), and
 *  optionally what to call them. `email` is always non-empty by construction
 *  — `parseReviewerIdentities` drops any entry that fails that. */
export interface ReviewerIdentity {
  email: string
  /** Display-only. Never compared — see `sameIdentity`'s doc comment for why
   *  a name difference must never manufacture a seat conflict. */
  name?: string
}

/** The seat consolidation writes into (`paper.annotations`, not
 *  `paper.reviews`) — see the module doc for why it shares the same hazard
 *  and the same key space as a numbered reviewer. */
export const CONSOLIDATION_SEAT = 'consolidation'

/** A key `Paper.reviews`/`reviewerIdentities` can use: a reviewer number
 *  ("1", "2", …) or the consolidation seat. Deliberately not shared with
 *  `parseReviews`' regex in `project.ts` — that key space genuinely excludes
 *  `consolidation` (there is no `reviews['consolidation']`; consolidation
 *  writes to `annotations`), so widening it there would be wrong, not just
 *  redundant. */
export function isSeatKey(key: string): boolean {
  return /^[1-9]\d*$/.test(key) || key === CONSOLIDATION_SEAT
}

/** "Reviewer 1" / "Consolidation" — shared by the merge refusal text and both
 *  seat UIs so the three never drift into describing the same seat two ways. */
export function seatLabel(seat: string): string {
  return seat === CONSOLIDATION_SEAT ? 'Consolidation' : `Reviewer ${seat}`
}

/** `null` for blank/absent — trimmed, lower-cased, so `" Alice@KIT.edu "` and
 *  `"alice@kit.edu"` are the same seat holder. Git enforces nothing about
 *  `user.email`'s casing or whitespace, so this has to. */
export function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase()
  return trimmed ? trimmed : null
}

/**
 * Whether two identities name the same person, by email alone. `name` is
 * deliberately excluded: people re-spell their own display name constantly
 * (`git config user.name` is free text, and "Jan Keim" becoming "Dr. Jan
 * Keim" is not a new person claiming the seat) and `merge.ts` uses this as
 * its merge comparator for `config.reviewerIdentities` — comparing `name`
 * there would make an ordinary name edit look like two different people
 * claiming the same seat and refuse the *entire* merge over it. `undefined`
 * on both sides counts as equal (no claim vs. no claim).
 */
export function sameIdentity(a: ReviewerIdentity | undefined, b: ReviewerIdentity | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return normalizeEmail(a.email) === normalizeEmail(b.email)
}

/**
 * Parse `config.reviewerIdentities` defensively, the same rule `parseReviews`/
 * `parseAiUsage` follow in `project.ts`: the file is hand-editable, so a
 * malformed entry is dropped, never thrown over. A key is kept only when it
 * looks like a seat (`isSeatKey`); an entry is kept only when its `email` is a
 * non-blank string. `name` is omitted entirely (never `name: ''`) when it is
 * not a non-blank string, so a dropped/blank name reads exactly like one that
 * was never supplied — `toReviewerIdentity` relies on that.
 */
export function parseReviewerIdentities(raw: unknown): Record<string, ReviewerIdentity> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, ReviewerIdentity> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSeatKey(key)) continue
    if (typeof value !== 'object' || value === null) continue
    const email = (value as Record<string, unknown>).email
    if (typeof email !== 'string' || !email.trim()) continue
    const identity: ReviewerIdentity = { email: email.trim() }
    const name = (value as Record<string, unknown>).name
    if (typeof name === 'string' && name.trim()) identity.name = name.trim()
    out[key] = identity
  }
  return out
}

/**
 * Canonical on-disk order: numeric seats ascending, then `consolidation`.
 * JS object-key iteration happens to already produce this (integer-like keys
 * sort first, ahead of insertion order), but a file that is meant to be
 * git-diffed must not depend on that quirk staying true across engines or
 * being an accident someone "fixes" — so this sorts explicitly and says why.
 * `undefined` (never emit an empty object) when there is nothing to write, so
 * a project nobody has claimed a seat in stays byte-identical to before this
 * field existed.
 */
export function serializeReviewerIdentities(
  identities: Record<string, ReviewerIdentity>,
): Record<string, ReviewerIdentity> | undefined {
  const keys = Object.keys(identities)
  if (keys.length === 0) return undefined
  const numeric = keys.filter((k) => k !== CONSOLIDATION_SEAT).sort((a, b) => Number(a) - Number(b))
  const ordered = [...numeric, ...(keys.includes(CONSOLIDATION_SEAT) ? [CONSOLIDATION_SEAT] : [])]
  const out: Record<string, ReviewerIdentity> = {}
  for (const k of ordered) out[k] = identities[k]
  return out
}

/** Build a claim from git's own strings (`GitIdentity`, kept as plain
 *  `string | null | undefined` here so this module imports nothing from
 *  `src/git/` — see the layering note in the plan this implements). `null`
 *  when there is no usable email: an unset `user.email`, the browser build (no
 *  git at all), or a repo this project isn't even in. */
export function toReviewerIdentity(
  email: string | null | undefined,
  name?: string | null,
): ReviewerIdentity | null {
  const trimmedEmail = email?.trim()
  if (!trimmedEmail) return null
  const trimmedName = name?.trim()
  return trimmedName ? { email: trimmedEmail, name: trimmedName } : { email: trimmedEmail }
}

/** How a claim is shown to a human: the name when there is one, the email
 *  either way (it is the actual identity; the name is only a courtesy) — used
 *  by both `ReviewerPrompt` and `Toolbar` so a seat holder reads the same way
 *  in the choose screen, the mismatch warning, and the toolbar hint. */
export function describeIdentity(identity: ReviewerIdentity): string {
  return identity.name ? `${identity.name} (${identity.email})` : identity.email
}

/** Who currently holds `seat`, or `undefined` if nobody has claimed it. */
export function seatHolder(
  identities: Record<string, ReviewerIdentity>,
  seat: string,
): ReviewerIdentity | undefined {
  return identities[seat]
}

export type SeatVerdict = { kind: 'ok' } | { kind: 'mismatch'; holder: ReviewerIdentity }

/**
 * Whether picking `seat` on this machine is safe, or needs a warning.
 *
 * Deliberately silent (never `mismatch`) whenever `myEmail` is `null` — a
 * machine with no git identity here (no repo, no git at all, or `user.email`
 * simply unset) cannot answer "is this me", and a warning on a question
 * nobody can settle is exactly the false alarm that teaches people to click
 * through real ones. See the plan's false-alarm table: this is the one row
 * that must stay silent even though a seat *is* claimed by someone else.
 */
export function checkSeat(
  identities: Record<string, ReviewerIdentity>,
  seat: string,
  myEmail: string | null,
): SeatVerdict {
  const holder = seatHolder(identities, seat)
  if (!holder) return { kind: 'ok' }
  if (myEmail === null) return { kind: 'ok' }
  return normalizeEmail(holder.email) === normalizeEmail(myEmail) ? { kind: 'ok' } : { kind: 'mismatch', holder }
}
