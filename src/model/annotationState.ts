import { completeness, hasRequiredFields, type Completeness } from './completeness'
import { hasAnnotations, type AnnotationValueTree } from './annotations'
import type { ResolvedDef } from './schema'
import type { Project } from './project'

/**
 * Where a paper stands for one reviewer seat — the single vocabulary behind
 * the paper list's dot, its state filter, and its "finished: 5/100" counter,
 * so those three can never tell different stories about the same paper.
 *
 * The two inputs are deliberately independent: how full the form is
 * (`Completeness`) is a fact about the data, and whether it is finished is a
 * reviewer's declaration (`Paper.finished`). Neither is derived from the
 * other; this function is the one place they are combined.
 *
 *  - `untouched` — nothing filled in, nothing declared.
 *  - `partial`   — some fields filled, still incomplete.
 *  - `complete`  — every field the dot counts is filled, but nobody has
 *                  ticked "Annotation finished" yet. Not a finished paper:
 *                  a full form has not been vouched for by anyone.
 *  - `finished`  — complete *and* declared finished. The only green state.
 *  - `flagged`   — declared finished while a **required** field is empty.
 *                  Reachable by ticking the box early, and by emptying such a
 *                  field on a paper that was already finished; the mark is
 *                  re-evaluated from the current data on every read, so it
 *                  flips to and from `finished` on its own as fields are
 *                  emptied and refilled — nothing has to be saved, and no
 *                  separate invalidation step exists to be missed. It reads
 *                  as an error rather than as progress, because a declaration
 *                  that contradicts the data is exactly that until a human
 *                  resolves it — by filling the field or by unticking the
 *                  box. Only reachable in a schema that marks something
 *                  required; see `hasRequired` below.
 */
export type AnnotationState = 'untouched' | 'partial' | 'complete' | 'finished' | 'flagged'

/**
 * `null` where completeness itself does not apply — a screening project or the
 * Consolidation seat (see `completenessApplies` in `PaperList.tsx`). Those
 * seats have their own dot meanings and no finished checkbox, so they have no
 * state in this vocabulary at all, rather than a misleading one.
 *
 * `hasRequired` is what makes `flagged` mean something. Red says "you called
 * this finished while a field that *had* to be filled is empty" — so it can
 * only ever fire in a schema that actually says which fields those are
 * (`required`). Where nothing is required, no empty field contradicts the
 * declaration: an unanswered question can be exactly the right record of a
 * paper that does not address it, and a reviewer who ticks the box has said
 * as much. Such a project simply never goes red, and its dots run empty →
 * amber → green.
 *
 * This is the same rule `validate.ts` enforces and `completeness.ts` counts by
 * ("not finished" = a required field left empty), so a red dot and the
 * Validate dialog can never disagree about the same paper — when anything is
 * required, `c` is already a fraction of required fields only, which makes
 * `filled === total` exactly "no required field is empty".
 *
 * Booleans are excluded from `c` entirely (see `completeness.ts`), so a Yes/No
 * field is never a hole: unticking one records "no", which is an answer, and
 * cannot turn a finished paper red — even when the schema marks it required.
 *
 * `touched` only matters for a schema with nothing countable in it (a
 * boolean-only schema): there, `filled`/`total` cannot distinguish anything,
 * so `hasAnnotations` stands in for "has this been worked on", and there is
 * nothing that could be left unfilled — so such a paper is never `flagged`,
 * only `finished` once declared.
 */
export function annotationState(
  c: Completeness | null,
  finished: boolean,
  touched: boolean,
  hasRequired: boolean,
  requireTick = true,
): AnnotationState | null {
  if (c === null) return null
  // `config.finishCheckbox: false` — nobody signs anything off, so a
  // fulfilled schema *is* finished (see `Project.finishCheckbox`). The stored
  // tick is not read at all: it may hold a declaration from before the option
  // was turned off, and honoring half of it would make two papers with
  // identical data show different colors for a reason the project has
  // declared irrelevant. `complete` and `flagged` are both unreachable here —
  // the first because a fulfilled schema goes straight to green, the second
  // because there is no declaration left for the data to contradict.
  if (!requireTick) {
    if (c.total === 0) return touched ? 'finished' : 'untouched'
    return c.filled === c.total ? 'finished' : c.filled === 0 ? 'untouched' : 'partial'
  }
  if (c.total === 0) return finished ? 'finished' : touched ? 'partial' : 'untouched'
  const complete = c.filled === c.total
  if (finished) return complete || !hasRequired ? 'finished' : 'flagged'
  if (complete) return 'complete'
  return c.filled === 0 ? 'untouched' : 'partial'
}

/**
 * Whether this vocabulary applies to a seat at all — the one gate behind the
 * dot's color, the finished checkbox, and the filter dropdown, so a seat can
 * never have two of the three.
 *
 * A screening project already has its own tri-state included/excluded/
 * undecided marker; the derived screening schema marks nothing required, so a
 * fill would count both of its fields (Decision, Reason) — meaning an
 * "Include" decision, which needs no Reason, would read as half done for a
 * paper that is actually settled. The Consolidation seat's dot means
 * *readiness* ("has every reviewer answered"), a different question that a
 * per-field fill cannot express without conflating it with how much
 * Consolidation itself has typed.
 */
export function completenessApplies(project: Project, currentReviewer: string | null): boolean {
  if (project.screening != null) return false
  if (project.reviewers > 1 && currentReviewer === 'consolidation') return false
  return true
}

/**
 * `annotationState` from a seat's raw tree — the convenience entry point for
 * callers that have a tree rather than a precomputed `Completeness` (the
 * store's landing-paper pick, the annotation panel). The paper list keeps
 * calling `annotationState` directly with the `Completeness` it already
 * computed for the dot's fill; both funnel into that one rule, so there is
 * still only one definition of what each state means.
 */
export function annotationStateFor(
  schema: ResolvedDef[],
  tree: AnnotationValueTree | null,
  finished: boolean,
  applies: boolean,
  requireTick = true,
): AnnotationState | null {
  if (!applies) return null
  return annotationState(
    completeness(schema, tree),
    finished,
    !!tree && hasAnnotations(schema, tree),
    hasRequiredFields(schema),
    requireTick,
  )
}

/**
 * What the paper list's filter dropdown offers — three buckets over the five
 * states, plus "all".
 *
 * The states exist to color a single dot precisely; a filter answers a
 * coarser question ("what still needs work?"), and five options to express
 * three intentions is a menu to read rather than a control to use. So:
 *
 *  - `in-progress` — simply every paper whose "Annotation finished" box is
 *    not ticked: untouched, part-filled, and filled-but-not-signed-off
 *    alike. Undoing annotations lands a paper back here, whether the values
 *    were cleared (`untouched` / `partial`) or the tick was removed
 *    (`complete`) — it is again a paper in progress, and no separate "was
 *    finished once" bucket survives to hide it from the list a reviewer
 *    works from.
 *  - `finished` — signed off and still holding.
 *  - `issues` — signed off while a required field is empty (`flagged`), the
 *    only state that is neither done nor merely unstarted.
 *
 * The dot keeps all five colors: within "in progress" the fill and its shade
 * still separate untouched from part-filled from ready-to-finish.
 */
export type AnnotationFilter = 'all' | 'in-progress' | 'finished' | 'issues'

/** Order shown in the dropdown: everything, then the natural progression. */
export const ANNOTATION_FILTERS: AnnotationFilter[] = ['all', 'in-progress', 'finished', 'issues']

/** The dropdown's options for a project, dropping `issues` where no paper can
 *  ever be in that state (`config.finishCheckbox: false` — see
 *  `annotationState`). An option that always selects nothing is worse than no
 *  option: it reads as "no problems found" rather than "not applicable". */
export function annotationFiltersFor(requireTick: boolean): AnnotationFilter[] {
  return requireTick ? ANNOTATION_FILTERS : ANNOTATION_FILTERS.filter((f) => f !== 'issues')
}

/** The dropdown's option text, and the word the counter under it uses
 *  ("finished: 5/100"). Lowercase so it reads as a sentence in the counter;
 *  the dropdown capitalizes the first letter itself. */
export const ANNOTATION_FILTER_LABELS: Record<AnnotationFilter, string> = {
  all: 'all papers',
  'in-progress': 'in progress',
  finished: 'finished',
  issues: 'with issues',
}

/**
 * Does a paper in `state` belong under `filter`? The single mapping from the
 * five dot states to the three buckets, so the list's rows and the counter
 * above them cannot disagree about what "in progress" contains.
 *
 * `null` — the seats with no annotation state at all (screening,
 * Consolidation) — matches only "all". A stale non-'all' filter carried over
 * from another seat (e.g. a numbered reviewer's filter surviving a switch to
 * Consolidation) CAN reach this with `state === null`; callers must decide
 * for themselves whether the current seat is filterable at all before
 * applying `annotationFilter` (PaperList does this via `isConsolidationSeat`).
 */
export function matchesFilter(state: AnnotationState | null, filter: AnnotationFilter): boolean {
  if (filter === 'all') return true
  if (state === null) return false
  if (filter === 'finished') return state === 'finished'
  if (filter === 'issues') return state === 'flagged'
  // "in progress" is the complement of the two ticked states: `finished` and
  // `flagged` are both papers whose box *is* ticked (they differ only in
  // whether the data still backs it), so everything else is a paper nobody
  // has called done.
  return state !== 'finished' && state !== 'flagged'
}
