/**
 * "Has this file changed since we last looked at it?" — the rule a save uses
 * to stop before overwriting somebody else's work.
 *
 * The renderer's save baseline (`src/platform/electron.ts`) knows what *this*
 * app last wrote, which is enough to write only the papers the reviewer
 * actually changed. It says nothing about the files having changed underneath
 * in the meantime, and in a shared repository they do: a teammate's `git pull`
 * run from a terminal, a `git checkout`, a sync client, a second copy of the
 * app. Saving over that loses answers with no conflict and no trace.
 *
 * Lives here rather than in `electron/main.ts` for the same reason
 * `relPathProblem` and `ownAnnotationPathMatcher` do: it is a decision about
 * plain values, it decides whether data gets overwritten, and `electron/` sits
 * outside vitest's scope. The main process supplies the `stat` results; this
 * decides what they mean.
 */

export interface StampedTarget {
  /** Repo- or project-relative path, for the message. */
  rel: string
  /** What this app recorded when it last read or wrote the file; `undefined`
   *  when it has never seen one there. */
  known: string | undefined
  /** What the file looks like now; `null` when it does not exist. */
  now: string | null
}

/**
 * Which of these would be overwritten destructively.
 *
 * Both directions count. A file whose stamp moved was rewritten by something
 * else since we read it. A file we have no stamp for but that nevertheless
 * *exists* appeared since the project was read — which is exactly what a
 * pulled annotation from a reviewer who previously had none looks like, and
 * writing over it would delete a whole reading.
 *
 * A file that is absent now is never a conflict: we are either creating it, or
 * deleting something already gone.
 */
export function changedTargets(targets: StampedTarget[]): string[] {
  return targets
    .filter(({ known, now }) => (known === undefined ? now !== null : now !== null && now !== known))
    .map((t) => t.rel)
}
