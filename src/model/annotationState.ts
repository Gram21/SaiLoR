import { completeness, hasRequiredFields, type Completeness } from './completeness'
import { hasAnnotations, type AnnotationValueTree } from './annotations'
import type { ResolvedDef } from './schema'
import type { Project } from './project'

/**
 * Where a paper stands for one reviewer seat — single vocabulary behind the
 * paper list's dot, state filter, and "finished: 5/100" counter.
 *
 * Completeness (fact about the data) and `finished` (reviewer's declaration)
 * are independent; this is the one place they combine.
 *
 *  - `untouched` — nothing filled in, nothing declared.
 *  - `partial`   — some fields filled, still incomplete.
 *  - `complete`  — form is full but not yet signed off.
 *  - `finished`  — complete *and* declared finished. The only green state.
 *  - `flagged`   — declared finished while a **required** field is empty.
 *                  Recomputed from current data on every read (no stored
 *                  invalidation step), so it flips to/from `finished` on its
 *                  own as fields are emptied/refilled. Only reachable when
 *                  the schema marks something required; see `hasRequired`.
 */
export type AnnotationState = 'untouched' | 'partial' | 'complete' | 'finished' | 'flagged'

/**
 * `null` where completeness doesn't apply — a screening project (see
 * `completenessApplies`), which has its own dot meaning and no finished
 * checkbox.
 *
 * `hasRequired` gates `flagged`: red only makes sense where the schema says
 * which fields must be filled. With nothing required, an empty field is a
 * valid answer, not a hole, so such a project never goes red.
 *
 * `c` already counts required fields only (matching `validate.ts` /
 * `completeness.ts`), so `filled === total` means exactly "no required field
 * empty" — keeping the dot and the Validate dialog in agreement.
 *
 * Booleans are excluded from `c` (see `completeness.ts`): unticking one is an
 * answer ("no"), never a hole, even if required.
 *
 * `touched` only matters for a boolean-only schema, where `filled`/`total`
 * can't distinguish anything; `hasAnnotations` stands in, and such a paper is
 * never `flagged`, only `finished` once declared.
 */
export function annotationState(
  c: Completeness | null,
  finished: boolean,
  touched: boolean,
  hasRequired: boolean,
  requireTick = true,
): AnnotationState | null {
  if (c === null) return null
  // `config.finishCheckbox: false` — nobody signs off, so a fulfilled schema
  // *is* finished; the stored tick is ignored so it can't leak a stale
  // declaration from before the option was turned off. `complete`/`flagged`
  // are unreachable here.
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
 * Whether this vocabulary applies to a project — gates the dot's color, the
 * finished checkbox, and the filter dropdown together.
 *
 * Only screening is excluded: its derived schema marks nothing required, so
 * counting both fields (Decision, Reason) would make an "Include" decision
 * (which needs no Reason) read as half done.
 *
 * Consolidation is included, using the same `Paper.finished` field a
 * single-reviewer seat ticks (see `currentFinished`/`setAnnotationFinished`
 * in store.ts). Note `adoptUnanimousValues` auto-fills unanimous answers into
 * the consolidated tree on open — the tick still decides the color, so an
 * auto-filled paper reads as `complete`, never `finished`, until a human says so.
 */
export function completenessApplies(project: Project): boolean {
  return project.screening == null
}

/**
 * Label for the sign-off checkbox — one definition, since the paper list's
 * `complete` tooltip names this control by label ("tick X in the panel").
 */
export function finishCheckboxLabel(isConsolidation: boolean): string {
  return isConsolidation ? 'Consolidation finished' : 'Annotation finished'
}

/**
 * `annotationState` from a seat's raw tree, for callers without a
 * precomputed `Completeness` (store's landing-paper pick, annotation panel).
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
 * Paper list's filter dropdown — four coarser buckets over the five states.
 *
 *  - `open` — box not ticked: untouched, partial, or complete-unsigned alike.
 *  - `in-progress` — the started subset of `open` (at least one entry
 *    recorded). Decided from `touched`, not from state, since a paper touched
 *    only via a Yes/No answer stays `untouched` (completeness ignores
 *    booleans) — see `matchesFilter`.
 *  - `finished` — signed off and still holding.
 *  - `issues` — signed off while a required field is empty (`flagged`).
 */
export type AnnotationFilter = 'all' | 'open' | 'in-progress' | 'finished' | 'issues'

/** Dropdown order: all, then `open` narrowing to `in-progress`, then the two ticked buckets. */
export const ANNOTATION_FILTERS: AnnotationFilter[] = ['all', 'open', 'in-progress', 'finished', 'issues']

/** Drops `issues` where no paper can ever reach it (`config.finishCheckbox: false`
 *  — see `annotationState`); an always-empty option would misread as "no problems". */
export function annotationFiltersFor(requireTick: boolean): AnnotationFilter[] {
  return requireTick ? ANNOTATION_FILTERS : ANNOTATION_FILTERS.filter((f) => f !== 'issues')
}

/** Dropdown option text and the counter's word ("finished: 5/100"). Lowercase
 *  so it fits the counter sentence; the dropdown capitalizes itself. */
export const ANNOTATION_FILTER_LABELS: Record<AnnotationFilter, string> = {
  all: 'all papers',
  open: 'open',
  'in-progress': 'in progress',
  finished: 'finished',
  issues: 'with issues',
}

/**
 * Does a paper belong under `filter`? Single mapping from the five dot
 * states (plus `touched`) to the buckets.
 *
 * `touched` is a separate input (not derived from `state`) because a paper
 * touched only via a Yes/No answer is `touched` while its state stays
 * `untouched` (completeness ignores booleans; see `annotationState`). Only
 * `in-progress` reads it, so other callers may omit it.
 *
 * `null` (screening; see `completenessApplies`) matches only "all", so a
 * filter carried over from an annotation project can't silently empty a
 * screening list.
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
  // `finished`/`flagged` are the ticked states; everything else is "not done".
  const unfinished = state !== 'finished' && state !== 'flagged'
  if (filter === 'in-progress') return unfinished && touched
  return unfinished // `open`
}
