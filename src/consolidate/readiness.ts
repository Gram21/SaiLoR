import { hasAnnotations, type AnnotationValueTree } from '../model/annotations'
import type { Paper } from '../model/project'
import type { ResolvedDef } from '../model/schema'

/**
 * Whether a paper is worth consolidating yet: every numbered reviewer has
 * recorded something on it.
 *
 * Consolidation is a comparison, and there is nothing to compare until the
 * reviewers have both had their say. Opening the compare popup on a paper one
 * reviewer has not reached shows their column empty — which reads as "they
 * found nothing here" when the truth is "they have not looked yet". That is a
 * misleading thing to ask someone to reconcile, so those papers are held back
 * rather than presented as half an answer.
 *
 * "Recorded something" is `hasAnnotations`, deliberately reusing the rule the
 * rest of the app already means by "annotated": an unticked box is not evidence
 * of anything — every boolean in the project reads `false` whether or not
 * anyone looked at it — but deliberately ticking one is a real act.
 *
 * A reviewer with no tree at all has plainly not started.
 */
export function readyToConsolidate(
  schema: ResolvedDef[],
  paper: Paper,
  reviewerCount: number,
): boolean {
  for (let i = 1; i <= reviewerCount; i++) {
    const tree = paper.reviews[String(i)]
    if (!tree || !hasAnnotations(schema, tree)) return false
  }
  return true
}

/** How many of a project's papers every reviewer has annotated, for the UI to report. */
export function readyCount(schema: ResolvedDef[], papers: Paper[], reviewerCount: number): number {
  return papers.filter((p) => readyToConsolidate(schema, p, reviewerCount)).length
}

/**
 * Whether the consolidator has committed an answer under `def`.
 *
 * The rule two callers must agree on: `alignConsolidationNode`, which refuses to
 * re-match a node once an answer hangs off it, and the batch adopt action, which
 * must then refuse to read that node across at a fixed index — alignment having
 * declined means the reviewers are left in whatever order they were already in,
 * and agreement found there would be an artefact of the index rather than of
 * what anyone said. Two copies of this rule drifting apart would mean the batch
 * adopting exactly the papers alignment judged unsafe to touch.
 */
export function consolidatorHasAnswered(def: ResolvedDef, consolidated: AnnotationValueTree): boolean {
  return hasAnnotations([def], { [def.name]: consolidated[def.name] ?? [] })
}
