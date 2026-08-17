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
 * `null` where completeness itself does not apply — a screening project (see
 * `completenessApplies` below). Screening has its own dot meaning and no
 * finished checkbox, so it has no state in this vocabulary at all, rather than
 * a misleading one.
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
 * Whether this vocabulary applies to a project at all — the one gate behind
 * the dot's color, the finished checkbox, and the filter dropdown, so a seat
 * can never have two of the three.
 *
 * Only a screening project is excluded. It already has its own tri-state
 * included/excluded/undecided marker; the derived screening schema marks
 * nothing required, so a fill would count both of its fields (Decision,
 * Reason) — meaning an "Include" decision, which needs no Reason, would read
 * as half done for a paper that is actually settled.
 *
 * **Consolidation is included**, which is why this needs no seat argument at
 * all. The consolidated tree is the record that actually ships, making it the
 * one tree in the project most in need of a sign-off — and the storage is
 * already there for it: `currentFinished`/`setAnnotationFinished` (store.ts)
 * route that seat's tick to `Paper.finished`, the same field the lone reviewer
 * of a single-reviewer project ticks. So the Consolidation dot reports the
 * consolidator's own progress and sign-off like any other seat's, and readiness
 * ("has every reviewer answered this paper") moves into the dot's tooltip — the
 * same trade `paperScreeningStatus` makes for this seat. Readiness keeps its
 * teeth where they matter: the compare popup's own gate (`Field.tsx`) is
 * untouched by this.
 *
 * What that fill deliberately does *not* claim is that a human filled it:
 * `adoptUnanimousValues` copies every unanimous answer into the consolidated
 * tree just from opening the paper. That is exactly why the tick still decides
 * the color rather than the data — an auto-filled paper reads as `complete`
 * ("ready to finish"), never as `finished`, until the consolidator says so.
 */
export function completenessApplies(project: Project): boolean {
  return project.screening == null
}

/**
 * What the annotation panel's sign-off checkbox is called in a seat — one
 * definition, because the paper list's `complete` tooltip sends the reader to
 * that control *by name* ("tick X in the panel"), and a tooltip naming a box
 * the seat does not have would send them hunting for it.
 *
 * Consolidation signs off the reconciled record rather than its own
 * extraction; the rule behind the box is identical either way (see
 * `completenessApplies`), only the noun changes to say which pass it ends.
 */
export function finishCheckboxLabel(isConsolidation: boolean): string {
  return isConsolidation ? 'Consolidation finished' : 'Annotation finished'
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
 * What the paper list's filter dropdown offers — four buckets over the five
 * states, plus "all".
 *
 * The states exist to color a single dot precisely; a filter answers a
 * coarser question ("what still needs work?"). So:
 *
 *  - `open` — every paper whose "Annotation finished" box is not ticked:
 *    untouched, part-filled, and filled-but-not-signed-off alike. Undoing
 *    annotations lands a paper back here, whether the values were cleared
 *    (`untouched` / `partial`) or the tick was removed (`complete`) — it is
 *    again an open paper, and no separate "was finished once" bucket survives
 *    to hide it from the list a reviewer works from.
 *  - `in-progress` — the started subset of `open`: papers with at least one
 *    annotation entry recorded, still not signed off. This is `open` minus the
 *    papers nobody has touched yet, so it answers "what have I actually begun
 *    and not finished". A paper touched only through a Yes/No answer counts as
 *    started even though its dot stays `untouched` (completeness ignores
 *    booleans), so this is decided from `touched`, not from the state — see
 *    `matchesFilter`.
 *  - `finished` — signed off and still holding.
 *  - `issues` — signed off while a required field is empty (`flagged`), the
 *    only state that is neither done nor merely unstarted.
 *
 * The dot keeps all five colors: within `open` the fill and its shade still
 * separate untouched from part-filled from ready-to-finish.
 */
export type AnnotationFilter = 'all' | 'open' | 'in-progress' | 'finished' | 'issues'

/** Order shown in the dropdown: everything, then the natural progression —
 *  `open` (all unfinished) narrowing to `in-progress` (only the started ones),
 *  then the two ticked buckets. */
export const ANNOTATION_FILTERS: AnnotationFilter[] = ['all', 'open', 'in-progress', 'finished', 'issues']

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
  open: 'open',
  'in-progress': 'in progress',
  finished: 'finished',
  issues: 'with issues',
}

/**
 * Does a paper belong under `filter`? The single mapping from the five dot
 * states (plus `touched`) to the buckets, so the list's rows and the counter
 * above them cannot disagree about what each bucket contains.
 *
 * `touched` — whether this seat has recorded at least one annotation entry for
 * the paper — is read only by `in-progress`, the started subset of `open`. It
 * is a separate input rather than something derived from `state` because the
 * two can legitimately disagree: a paper touched only through a Yes/No answer
 * is `touched` while its dot state is still `untouched` (completeness ignores
 * booleans; see `annotationState`). It defaults to `false`, which the other
 * buckets never consult, so a caller asking about any of them may omit it.
 *
 * `null` — no annotation state at all, which is now only a screening project
 * (`completenessApplies`) — matches only "all", so a filter carried over from
 * an annotation project cannot silently empty a screening list. Callers must
 * still decide for themselves whether the current seat is filterable at all
 * before applying `annotationFilter`; PaperList does this by offering the
 * screening filter instead.
 */
export function matchesFilter(
  state: AnnotationState | null,
  filter: AnnotationFilter,
  touched = false,
): boolean {
  if (filter === 'all') return true
  if (state === null) return false
  if (filter === 'finished') return state === 'finished'
  if (filter === 'issues') return state === 'flagged'
  // `open` and `in-progress` both exclude the two ticked states: `finished`
  // and `flagged` are the papers whose box *is* ticked (they differ only in
  // whether the data still backs it), so everything else is a paper nobody has
  // called done.
  const unfinished = state !== 'finished' && state !== 'flagged'
  // `in-progress` narrows that to the papers actually started; an untouched
  // paper is `open` but not yet in progress.
  if (filter === 'in-progress') return unfinished && touched
  return unfinished // `open`
}
