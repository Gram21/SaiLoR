import { hasAnnotations, type AnnotationValueTree } from '../model/annotations'
import type { Paper } from '../model/project'
import type { ResolvedDef } from '../model/schema'
import { alignableNodes } from './align'

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

/**
 * Whether a paper has a repeatable node (Findings, say) that two or more
 * reviewers recorded entries in, but that Consolidation has not reviewed yet
 * — `useConsolidationAlignment.ts` only aligns a node once Consolidation
 * opens *that specific paper*, so a paper nobody has consolidated yet can
 * still have its reviewers' entries in whatever order each of them happened
 * to enter them.
 *
 * Reading such a paper's entries at a fixed index — which is what
 * `disagreements.ts`'s verdicts and `agreement.ts`'s coefficients both do —
 * then compares entries that are not about the same thing, and can read as
 * near-total disagreement between reviewers who actually agreed, just in a
 * different order. `consolidatorHasAnswered` is used as the signal here —
 * matching the meaning `adoptAllUnanimousAnnotations` already gives it (see
 * store.ts) — but it is a "has this been reviewed" signal, not strictly a
 * "has this been aligned" one: `alignConsolidationNode` reorders the raw
 * reviewer arrays *before* any answer exists, so a node can be correctly
 * aligned yet still read as "needs alignment" here until the consolidator (or
 * the batch adopt-unanimous action) actually commits a value under it. That
 * is the conservative side to be wrong on — a caution that outlives its
 * cause is a nuisance; a caution that clears itself before a human ever
 * looked is the failure this whole function exists to prevent.
 */
export function needsAlignment(schema: ResolvedDef[], paper: Paper, reviewerCount: number): boolean {
  for (const nodeName of alignableNodes(schema)) {
    const def = schema.find((d) => d.name === nodeName)
    if (!def || consolidatorHasAnswered(def, paper.annotations)) continue
    let reviewersWithEntries = 0
    for (let i = 1; i <= reviewerCount; i++) {
      const tree = paper.reviews[String(i)]
      // `hasAnnotations`, not "the array is non-empty": `normalizeTree` always
      // pads a node to at least one instance, so an untouched reviewer still
      // has a slot there — just an empty one, same as `consolidatorHasAnswered`
      // treats an untouched consolidated node.
      if (tree && hasAnnotations([def], { [def.name]: tree[def.name] ?? [] })) reviewersWithEntries++
    }
    if (reviewersWithEntries >= 2) return true
  }
  return false
}

/** How many of a project's papers `needsAlignment` — for a warning banner. */
export function needsAlignmentCount(schema: ResolvedDef[], papers: Paper[], reviewerCount: number): number {
  return papers.filter((p) => needsAlignment(schema, p, reviewerCount)).length
}
