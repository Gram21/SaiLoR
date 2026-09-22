import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { useGitStore } from '../state/gitStore'
import { getPlatform } from '../platform'
import { readyCount } from '../consolidate/readiness'
import { sameIdentity, ownerLabel, CONSOLIDATION_SEAT } from '../git/seatOwner'
import type { SeatOwners } from '../git/types'

/**
 * Shown when a multi-reviewer project is opened and nobody has picked a seat —
 * which, because the choice is persisted per project, means the first time this
 * file is opened on this machine.
 *
 * Until now that state was a single line where the annotation form should be.
 * It said what to do but not why any of it exists, and the whole point of a
 * multi-reviewer file — that reviewers work *independently*, that you will not
 * see anyone else's answers, that a separate pass reconciles them — is exactly
 * the thing a reviewer needs to know before they start rather than after.
 *
 * There is deliberately no way out but choosing: the choose screen withholds
 * the form without a seat anyway, so a dismiss button would only offer a state
 * in which nothing can be done. The choice is free, reversible from the
 * toolbar, and costs nothing to change later.
 *
 * Free, but not free of consequence once somebody else is already in the seat:
 * two people who both pick "Reviewer 1" write the same files, and whoever
 * merges last silently erases the other's answers. So when the project sits in
 * a git repository, each seat also says who has been committing it (see
 * `src/git/seatOwner.ts`) and taking somebody else's asks a second time.
 */
export function ReviewerPrompt() {
  const project = useStore((s) => s.project)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const selectReviewer = useStore((s) => s.selectReviewer)
  const helpOpen = useStore((s) => s.helpOpen)
  const repo = useGitStore((s) => s.repo)
  const [owners, setOwners] = useState<SeatOwners | null>(null)
  // The seat a second click would take from its current holder — reset by
  // every other interaction, so the confirmation can't be answered by accident.
  const [confirming, setConfirming] = useState<string | null>(null)

  const reviewers = project?.reviewers ?? 0
  const screening = !!project?.screening
  useEffect(() => {
    const git = getPlatform().getGit()
    if (!git || !repo || reviewers <= 1) {
      setOwners(null)
      return
    }
    let live = true
    const seats = [...Array.from({ length: reviewers }, (_, i) => String(i + 1)), CONSOLIDATION_SEAT]
    // Best-effort: a repository this can't read tells us nothing about who
    // holds a seat, which is the same state as a project outside git — say
    // nothing rather than block the only screen that can be reached here.
    void git
      .seatOwners(repo.root, repo.relPath, seats, screening)
      .then((r) => {
        if (live) setOwners(r)
      })
      .catch(() => {
        if (live) setOwners(null)
      })
    return () => {
      live = false
    }
  }, [repo, reviewers, screening])

  if (!project || project.reviewers <= 1) return null
  // Yield to Help. Nothing else can be reached while this is up, so F1 is the
  // one way to go and read more before committing to a seat — and it would be
  // perverse for the prompt explaining multi-review to be what stops you.
  if (helpOpen) return null

  if (currentReviewer !== null) return null

  const reviewerIds = Array.from({ length: project.reviewers }, (_, i) => String(i + 1))
  const ready = readyCount(project.schema, project.papers, project.reviewers)
  const total = project.papers.length

  /** Who holds `seat`, and whether that is somebody other than this machine.
   *  A seat nobody has committed is unclaimed, not contested. */
  const holderOf = (seat: string) => {
    const owner = owners?.seats[seat] ?? null
    if (!owner) return null
    return { owner, isMine: sameIdentity(owner, owners?.me ?? null) }
  }
  // Nothing rendered at all until some seat has a claim, so a fresh project —
  // or one outside git — looks exactly as it did before any of this existed.
  const hasClaims = reviewerIds.concat(CONSOLIDATION_SEAT).some((s) => holderOf(s) !== null)

  /** One click for a free seat or your own; two for taking somebody else's. */
  const choose = (seat: string) => {
    const held = holderOf(seat)
    if (held && !held.isMine && confirming !== seat) {
      setConfirming(seat)
      return
    }
    selectReviewer(seat)
  }

  const holderNote = (seat: string) => {
    const held = holderOf(seat)
    if (!hasClaims) return null
    if (!held) return <span className="reviewer-prompt-holder">not yet committed by anyone</span>
    if (held.isMine) return <span className="reviewer-prompt-holder">last committed by you</span>
    return (
      <span className="reviewer-prompt-holder">
        {confirming === seat
          ? `Take it from ${ownerLabel(held.owner)}?`
          : `last committed by ${ownerLabel(held.owner)}`}
      </span>
    )
  }

  return (
    // Opt-out marker excludes this overlay from useKeybindings.ts's F1 guard,
    // so F1 still opens Help while this prompt is up (see that file's F1
    // branch for why the exclusion lives there and not in a keydown handler
    // here).
    <div className="modal-overlay" data-yields-to-help>
      <div className="modal reviewer-prompt" role="dialog" aria-modal="true">
        <div className="modal-head">
          <strong>This review has {project.reviewers} reviewers</strong>
        </div>
        <div className="modal-body">
          <p>
            Every paper here is annotated <strong>independently</strong> by {project.reviewers}{' '}
            people. You will see and edit <strong>only your own</strong> answers — not anyone else's.
            That is the point: an SLR's reviewers are meant to reach their findings separately, so
            that where they agree means something.
          </p>
          <p>
            Pick the reviewer seat you are using for this session. Your selection is remembered only
            on this machine for this project and is never written to the project file.
          </p>
          <p>
            <strong>Consolidation</strong> is the pass that comes after. Whoever takes that seat sees
            everyone's answers side by side, settles the disagreements, and records the project's
            final result. It is not another opinion — it is the reconciliation of the others.
          </p>
          <p className="reviewer-prompt-ask">Which are you?</p>
          <div className="reviewer-prompt-choices">
            {reviewerIds.map((id) => {
              return (
                <button
                  key={id}
                  type="button"
                  className="reviewer-prompt-choice"
                  onClick={() => choose(id)}
                  title={
                    confirming === id
                      ? `Click again to annotate as Reviewer ${id} anyway`
                      : `Review independently as Reviewer ${id}`
                  }
                >
                  Reviewer {id}
                  {holderNote(id)}
                </button>
              )
            })}
            <button
              type="button"
              className="reviewer-prompt-choice is-consolidation"
              onClick={() => choose(CONSOLIDATION_SEAT)}
              title={
                total > 0 && ready === total
                  ? 'Every paper has been annotated by all reviewers'
                  : 'Papers not yet annotated by every reviewer cannot be compared yet'
              }
            >
              Consolidation
              {/* Says how much there is to do rather than blocking the seat: a
                  consolidator may legitimately want to start on the papers that
                  are ready while the rest are still being reviewed. The ones
                  that are not ready say so in the list and keep their compare
                  popups shut. */}
              <span className="reviewer-prompt-ready">
                {total === 0
                  ? 'no papers yet'
                  : ready === 0
                    ? 'no papers ready yet'
                    : `${ready} of ${total} papers ready`}
              </span>
              {holderNote(CONSOLIDATION_SEAT)}
            </button>
          </div>
          <p className="reviewer-prompt-note">
            Remembered for this project — you can switch from the toolbar whenever you like. Press
            F1 to read Help before choosing.
          </p>
        </div>
      </div>
    </div>
  )
}
