import { isField, type ResolvedDef } from '../model/schema'
import type { AnnotationValueTree, FieldValue } from '../model/annotations'
import { isUnanswered } from '../llm/fields'
import { formatPath, type RawSeg } from '../llm/paths'

/**
 * Find the fields every reviewer answered the same way.
 *
 * These are the consolidator's busywork: there is nothing to reconcile when
 * everyone already agrees, and copying the same answer across by hand is the
 * kind of task that gets done on autopilot — which is exactly when a real
 * disagreement two rows further down gets missed. Adopting them automatically
 * leaves the consolidator's attention for the fields that actually differ.
 *
 * Nothing here is a guess: the value written is one the reviewers all recorded.
 * It is still marked in the UI (the same light-blue border the AI's fills get)
 * so it is visibly *the app's* doing until the consolidator has looked at it.
 */

/** One field to fill, and the value every reviewer gave it. */
export interface UnanimousFill {
  /** Container path — the segments above the field. */
  path: RawSeg[]
  name: string
  index: number
  /** Canonical path ("Findings[1]/Claim"), for the mark key. */
  canonical: string
  value: FieldValue
}

/**
 * The form two answers are compared in when deciding whether the reviewers said
 * the same thing.
 *
 * Case and whitespace are how one answer gets typed twice, not a disagreement:
 * "Controlled experiment" and "controlled  experiment " are one answer. Nothing
 * beyond that is folded away — punctuation is left alone, because this decides
 * whether to write a value into the final result unasked, and whether an
 * agreement statistic counts two reviewers as agreeing. The bar for both is
 * "they said the same thing", not "close enough".
 *
 * Deliberately *not* `similarity.ts`'s `normalizeText`, which also strips
 * punctuation and exists to rank fuzzy matches. Reach for that one to decide
 * which entries are the same entry; reach for this one to decide whether two
 * answers are the same answer. Confusing them would make "RCT" and "RCT?" a
 * silent agreement.
 *
 * Exported because agreement has three consumers that must reach the same
 * verdict — this module, `disagreements.ts`, and the compare popup. They each
 * had their own copy and a comment asking the next person to keep three
 * implementations in sync by hand; one of them drifting would mean the popup
 * saying "reviewers agree" while the statistic counted a disagreement.
 */
export function comparable(value: FieldValue | undefined): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/\s+/g, ' ')
    : JSON.stringify(value)
}

/** Surrounding whitespace is noise nobody meant; the wording itself is kept. */
function tidy(value: FieldValue): FieldValue {
  return typeof value === 'string' ? value.trim() : value
}

/**
 * The value every reviewer gave this field, or `undefined` if they did not all
 * give the same one.
 *
 * Every reviewer must have actually answered. A field two reviewers agree on and
 * a third left blank is *not* unanimous: silence is not assent, and the third
 * reviewer may simply not have got there yet. This is also what keeps booleans
 * honest — an unticked box reads `false` exactly like a deliberate "no", so
 * `isUnanswered` treats a boolean as answered only once it is ticked. Without
 * that, every untouched checkbox in the project would count as a unanimous
 * `false` and get adopted and marked, burying the real agreements in noise.
 */
function agreedValue(def: ResolvedDef, values: Array<FieldValue | undefined>): FieldValue | undefined {
  // One opinion is not agreement.
  if (values.length < 2) return undefined
  if (values.some((v) => isUnanswered(def, v))) return undefined
  const keys = new Set(values.map((v) => comparable(v as FieldValue)))
  if (keys.size !== 1) return undefined
  // They agree, so any of them is right; the lowest-numbered reviewer's wording
  // is taken to keep the choice deterministic rather than arbitrary.
  return tidy(values[0] as FieldValue)
}

/**
 * Every field the reviewers agree on that the consolidated tree has not answered.
 *
 * `reviews` must be keyed by **every** numbered reviewer, with `undefined` for
 * one who has not touched this paper — a missing tree is an unanswered field,
 * not an absent voter (see `agreedValue`).
 *
 * Reads across at a fixed index, which is only meaningful once the entries have
 * been lined up by `applyAlignment` — before that, index N is a different entry
 * for each reviewer and "they agree" would be nonsense. The scheduler runs this
 * after the matching for that reason.
 */
export function unanimousFills(
  defs: ResolvedDef[],
  reviews: Record<string, AnnotationValueTree | undefined>,
  consolidated: AnnotationValueTree,
): UnanimousFill[] {
  const out: UnanimousFill[] = []
  walk(defs, reviews, consolidated, [], out)
  return out
}

function walk(
  defs: ResolvedDef[],
  reviews: Record<string, AnnotationValueTree | undefined>,
  consolidated: AnnotationValueTree | undefined,
  prefix: RawSeg[],
  out: UnanimousFill[],
): void {
  const reviewerIds = Object.keys(reviews)

  for (const def of defs) {
    // The consolidated tree drives the walk: it is what can be filled, and
    // `applyAlignment` has already grown it to one entry per matched entry.
    const raw = consolidated?.[def.name]
    const instances = Array.isArray(raw) ? raw : []

    instances.forEach((inst, index) => {
      const segs = [...prefix, { name: def.name, index }]

      if (isField(def) && isUnanswered(def, inst?.value)) {
        const agreed = agreedValue(
          def,
          reviewerIds.map((r) => reviews[r]?.[def.name]?.[index]?.value),
        )
        if (agreed !== undefined) {
          out.push({ path: prefix, name: def.name, index, canonical: formatPath(segs), value: agreed })
        }
      }

      if (def.children.length > 0) {
        const childReviews: Record<string, AnnotationValueTree | undefined> = {}
        for (const r of reviewerIds) {
          childReviews[r] = reviews[r]?.[def.name]?.[index]?.children
        }
        walk(def.children, childReviews, inst?.children, segs, out)
      }
    })
  }
}
