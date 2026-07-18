import type { AnnotationValueTree } from '../model/annotations'
import type { Paper, Project } from '../model/project'
import { unanimousFills } from '../consolidate/unanimous'
import { SCREENING_DECISION } from './schema'
import { screeningReason, screeningStatus } from './status'

/**
 * The tree a given seat reads for `paper` — the same routing `currentTree`
 * (`state/store.ts`) applies, reimplemented here rather than imported so this
 * module stays store-free and independently testable, matching the precedent
 * `consolidate/disagreements.ts` and `consolidate/readiness.ts` already set.
 * Read-only: unlike the store's own `currentTree(..., create=true)`, this
 * never creates a reviewer's tree, only reads whatever is already there.
 */
function seatTree(
  project: Project,
  currentReviewer: string | null,
  paper: Paper,
): AnnotationValueTree | null {
  if (project.reviewers <= 1) return paper.annotations
  if (currentReviewer === 'consolidation') return paper.annotations
  if (currentReviewer === null) return null
  return paper.reviews[currentReviewer] ?? null
}

export interface ScreeningCounts {
  total: number
  included: number
  excluded: number
  undecided: number
  /**
   * Reason → papers excluded for it. Every configured reason is a key, including
   * the ones nobody used: PRISMA reports the pre-registered list in full, and a
   * reason that eliminated nothing is a finding, not an absence.
   */
  byReason: Record<string, number>
  /**
   * Excluded papers whose reason is blank or not one of the configured ones.
   * Its own bucket rather than folded into a reason nobody picked — the number
   * is only honest if it says what it does not know.
   */
  excludedWithoutReason: number
}

/**
 * Counts over the tree the given seat is responsible for — the same routing
 * `currentTree` uses, so a numbered reviewer sees their own progress and
 * Consolidation sees the result that actually ships.
 */
export function screeningCounts(project: Project, currentReviewer: string | null): ScreeningCounts {
  const reasons = project.screening?.reasons ?? []
  // Null-prototype: reasons come from the project file, which is hand-editable
  // by design, and a reason of "constructor" or "__proto__" would otherwise be
  // found on Object.prototype — booking the paper against an inherited member
  // instead of counting it as having no recorded reason.
  const byReason: Record<string, number> = Object.create(null)
  for (const r of reasons) byReason[r] = 0

  let included = 0
  let excluded = 0
  let undecided = 0
  let excludedWithoutReason = 0

  for (const paper of project.papers) {
    const tree = seatTree(project, currentReviewer, paper)
    const status = screeningStatus(tree)
    if (status === 'included') included++
    else if (status === 'undecided') undecided++
    else {
      excluded++
      const reason = screeningReason(tree)
      if (reason && Object.hasOwn(byReason, reason)) byReason[reason]++
      else excludedWithoutReason++
    }
  }

  return {
    total: project.papers.length,
    included,
    excluded,
    undecided,
    byReason,
    excludedWithoutReason,
  }
}

/**
 * Papers holding something every numbered reviewer recorded identically that
 * Consolidation has not adopted yet — a decision, a reason, or both. Zero for a
 * single-reviewer project.
 *
 * These exist because `adoptUnanimousValues` (state/store.ts) only runs for the
 * paper open in the Consolidation seat, so a project whose consolidator never
 * opened paper X has no consolidated decision for it even though the reviewers
 * agreed. Reported rather than fixed silently — see `adoptAllUnanimousScreening`.
 *
 * Counts *any* pending fill, because this drives the notice sitting next to the
 * "Adopt all" button and that button adopts everything unanimous. Counting only
 * decisions made the two disagree: two reviewers who both excluded a paper for
 * the same reason, where the consolidator set the decision by hand and left the
 * reason blank, produced a reason fill and no decision fill — no notice,
 * nothing offering to adopt the reason, and the paper booked as
 * excluded-without-a-reason permanently.
 *
 * For "how many papers still have no final decision", which is a different
 * question with a different answer, use {@link pendingUnanimousDecisions}.
 */
export function pendingUnanimous(project: Project): number {
  return countPendingUnanimous(project, false)
}

/**
 * Papers that are still undecided *and* whose reviewers all chose the same
 * decision — the ones where adopting would change the included/excluded counts.
 *
 * Separate from {@link pendingUnanimous} on purpose. The screening-import
 * dialog speaks specifically about "the not-yet-screened papers" and about the
 * project having no final decision for them, so a paper that already has a
 * decision and merely lacks a unanimous *reason* must not be counted there: the
 * sentence would be false, promising that adopting changes an inclusion count
 * that is already settled.
 */
export function pendingUnanimousDecisions(project: Project): number {
  return countPendingUnanimous(project, true)
}

function countPendingUnanimous(project: Project, decisionsOnly: boolean): number {
  if (project.reviewers <= 1) return 0
  let count = 0
  for (const paper of project.papers) {
    const reviews: Record<string, AnnotationValueTree | undefined> = {}
    for (let i = 1; i <= project.reviewers; i++) reviews[String(i)] = paper.reviews[String(i)]
    const fills = unanimousFills(project.schema, reviews, paper.annotations)
    const matches = decisionsOnly
      ? fills.some((f) => f.path.length === 0 && f.name === SCREENING_DECISION)
      : fills.length > 0
    if (matches) count++
  }
  return count
}
