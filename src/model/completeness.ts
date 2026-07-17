import type { ResolvedDef } from './schema'
import { isField } from './schema'
import type { AnnotationValueTree } from './annotations'
import { isEmptyValue } from './validate'

/**
 * How much of a paper's answerable surface is filled in — the numbers behind
 * the paper list's completeness dot (`PaperList.tsx`). Store-free and
 * DOM-free, like `screening/counts.ts`: this only ever reads a resolved
 * schema and a value tree.
 */
export interface Completeness {
  filled: number
  total: number
}

/** True if `required` appears anywhere in the schema, including nested groups. */
export function hasRequiredFields(defs: ResolvedDef[]): boolean {
  return defs.some((def) => (isField(def) && def.required) || hasRequiredFields(def.children))
}

/**
 * `filled`/`total` over a paper's tree, for the completeness dot.
 *
 * Denominator (see `hasRequiredFields`): required fields only when the schema
 * marks anything required, otherwise every field. `validate.ts` already
 * defines "not finished" as "a required field left empty" — wherever that
 * rule has teeth, the dot must count the same fields it does, or the dot and
 * the validation dialog would disagree about the same paper. Where nothing is
 * required (the common case today — `required` is opt-in), that rule is
 * vacuous and required-only would mean 0/0 for every paper; counting every
 * field is the only fallback under which the dot can ever read 100%.
 *
 * Booleans are excluded from both `filled` and `total`, on both sides of the
 * codebase's own disagreement about them: `isEmptyValue` (below) says a
 * boolean is never empty, so counting it would make an untouched paper read
 * as partially filled; `hasAnnotations`'s private `isEmptyInstance`
 * (`annotations.ts`) says the opposite — a boolean counts only when `true` —
 * which would make a correctly-recorded `false` unreachable. Neither rule is
 * safe to reuse here, so, matching `annotationText`'s reason for the same
 * exclusion, booleans carry no completeness signal and are left out entirely.
 *
 * Repeatable nodes have no fixed size, so the denominator comes from the data:
 * every instance actually present in `tree` is counted once, not one per
 * schema def and not `pruneTree`d first. That keeps the ratio matching
 * exactly what the form is showing — adding an empty entry lowers the ratio
 * (the form now really does show one more unanswered field), and removing it,
 * or saving (which drops trailing empties), recovers it.
 */
export function completeness(
  defs: ResolvedDef[],
  tree: AnnotationValueTree | null | undefined,
): Completeness {
  const acc: Completeness = { filled: 0, total: 0 }
  walk(defs, tree ?? {}, hasRequiredFields(defs), acc)
  return acc
}

// Defensive like `annotations.ts`'s tree walks (`collectAnnotationText`,
// `isEmptyInstance`): the project JSON is hand-editable, so a value tree may
// not match the schema's shape at runtime, and this runs on every render.
function walk(
  defs: ResolvedDef[],
  tree: AnnotationValueTree,
  requiredOnly: boolean,
  acc: Completeness,
): void {
  for (const def of defs) {
    const raw = tree?.[def.name]
    const instances = Array.isArray(raw) ? raw : []
    for (const inst of instances) {
      if (!inst || typeof inst !== 'object') continue
      if (isField(def) && def.type !== 'boolean' && (!requiredOnly || def.required)) {
        acc.total++
        if (!isEmptyValue(def.type, inst.value)) acc.filled++
      }
      if (def.children.length > 0) {
        walk(def.children, inst.children ?? {}, requiredOnly, acc)
      }
    }
  }
}

/**
 * Percent full for the dot's fill, or `null` when there is nothing countable
 * (`total === 0`) — a boolean-only schema, an absent tree, or a schema no
 * data has reached yet. Callers fall back to a binary dot in that case.
 *
 * `filled === 0` and `filled === total` map to the exact 0/100 endpoints so a
 * caller can render them with the plain empty/`.done` dot, unchanged from
 * before this module existed. Everything in between is clamped to [5, 99]:
 * the dot's pre-existing meaning was "touched vs not", and that must not
 * regress now that it also shows degree — 199/200 must not *look* complete
 * (only a genuinely finished paper should), and 1/200 must not *look*
 * untouched (only a genuinely empty paper should).
 */
export function completenessPercent(c: Completeness): number | null {
  if (c.total === 0) return null
  if (c.filled === 0) return 0
  if (c.filled === c.total) return 100
  return Math.min(99, Math.max(5, Math.floor((c.filled / c.total) * 100)))
}
