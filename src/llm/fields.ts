import type { ResolvedDef } from '../model/schema'
import { isField } from '../model/schema'
import type { AnnotationValueTree, FieldValue } from '../model/annotations'
import { isEmptyValue } from '../model/validate'
import { formatPath, type RawSeg } from './paths'

/** One field the AI will be asked about, with the value it currently holds. */
export interface FieldTarget {
  /** Canonical path, e.g. "Findings/Evidence/Metric". */
  path: string
  def: ResolvedDef
  value: FieldValue | undefined
}

/**
 * Whether the AI should be asked to answer this field.
 *
 * For strings and numbers this is exactly `validate.ts`'s notion of empty, so
 * "the AI fills what the validator would complain about" holds.
 *
 * Booleans need their own rule. The data model cannot represent an *unanswered*
 * boolean — an unticked box and a deliberate "false" are the same `false`, which
 * is why `isEmptyValue` treats booleans as never empty. Applying that rule here
 * would mean the AI could never propose a value for a boolean field at all,
 * including the archetypal one ("Relevant"). So a boolean is offered unless it is
 * already ticked: the AI can propose flipping it to true, never to false, and it
 * can never silently clear a box the reviewer ticked. The reviewer still approves
 * every row before anything is written.
 */
export function isUnanswered(def: ResolvedDef, value: FieldValue | undefined): boolean {
  if (def.type === 'boolean') return value !== true
  return isEmptyValue(def.type, value)
}

/**
 * Every field in the schema that is still unanswered for this paper, in schema
 * order. Walks the *existing* instances only: a repeatable node contributes the
 * entries it currently has. The model may still record further entries by naming
 * the next free index (the prompt says so, and `resolvePath` allows it) — those
 * instances get created at apply time.
 */
export function unansweredFields(
  schema: ResolvedDef[],
  tree: AnnotationValueTree | undefined,
): FieldTarget[] {
  const out: FieldTarget[] = []
  walk(schema, tree, [], out)
  return out
}

function walk(
  defs: ResolvedDef[],
  tree: AnnotationValueTree | undefined,
  prefix: RawSeg[],
  out: FieldTarget[],
): void {
  for (const def of defs) {
    // A normalized tree always has at least one instance per node, but the JSON is
    // hand-editable and may hold anything here. A missing node — or one holding
    // something other than a list of instances — is treated as a single empty
    // instance: the AI can then offer to fill it, and `validate.ts` separately
    // reports the malformed shape to the reviewer.
    const raw = tree?.[def.name]
    const instances = Array.isArray(raw) ? raw : [{}]
    instances.forEach((inst, index) => {
      const segs = [...prefix, { name: def.name, index }]
      if (isField(def) && isUnanswered(def, inst?.value)) {
        out.push({ path: formatPath(segs), def, value: inst?.value })
      }
      if (def.children.length > 0) {
        walk(def.children, inst?.children, segs, out)
      }
    })
  }
}
