import type { ResolvedDef } from '../model/schema'
import { isField } from '../model/schema'
import type { PathSeg } from '../state/store'

/**
 * Field paths, as used in the LLM contract: node names joined with "/", each
 * optionally indexed to pick one entry of a repeated node.
 *
 *   "Study Type"                     → the top-level field
 *   "Findings[1]/Evidence[0]/Metric" → Metric of the first Evidence of the SECOND Finding
 *
 * A bare name means index 0. The model is allowed to name an index that does not
 * exist yet (that is how it records a further entry of a repeatable node), so
 * resolution is checked against the **schema**, not against the current data —
 * the caller creates any missing instances when applying.
 */

/** A path split into segments, before it has been checked against a schema. */
export interface RawSeg {
  name: string
  index: number
}

/** A path that has been checked against the schema and points at a real field. */
export interface ResolvedPath {
  /** Segments identifying the *container* the field lives in (may be empty). */
  path: PathSeg[]
  /** The field node's own name and instance index. */
  name: string
  index: number
  def: ResolvedDef
  /** Canonical form, e.g. "Findings[1]/Metric" — indices omitted when 0. */
  canonical: string
}

// A segment is a name (anything but "/" and "[") with an optional [n] suffix.
const SEG = /^([^/[\]]+?)(?:\[(\d+)\])?$/

/** Split "A[1]/B" into segments. Returns null when the syntax is malformed. */
export function parsePath(raw: string): RawSeg[] | null {
  if (typeof raw !== 'string') return null
  const parts = raw.split('/')
  if (parts.length === 0) return null

  const segs: RawSeg[] = []
  for (const part of parts) {
    const m = SEG.exec(part.trim())
    if (!m) return null
    const index = m[2] === undefined ? 0 : Number(m[2])
    if (!Number.isSafeInteger(index) || index < 0) return null
    segs.push({ name: m[1].trim(), index })
  }
  return segs
}

/** Canonical text form. Index 0 is left implicit, so paths compare stably. */
export function formatPath(segs: RawSeg[]): string {
  return segs.map((s) => (s.index === 0 ? s.name : `${s.name}[${s.index}]`)).join('/')
}

/** Human-readable form for the UI, matching validate.ts's style: "Findings #2 › Claim". */
export function displayPath(segs: RawSeg[]): string {
  return segs.map((s) => (s.index === 0 ? s.name : `${s.name} #${s.index + 1}`)).join(' › ')
}

/**
 * Check a path against the schema and return the field it names, or null.
 *
 * Rejects: unknown names, a non-final segment that has no children, a final
 * segment that is not a field (a group holds no value), and any index at or
 * beyond the node's `max`. Everything the model sends goes through here, so a
 * model that ignores the contract cannot reach the project data.
 */
export function resolvePath(schema: ResolvedDef[], raw: string): ResolvedPath | null {
  const segs = parsePath(raw)
  if (!segs || segs.length === 0) return null

  let level: ResolvedDef[] = schema
  const container: PathSeg[] = []

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const def = level.find((d) => d.name === seg.name)
    if (!def) return null

    // `max: null` means unbounded; otherwise the index must fit inside it.
    if (def.max !== null && seg.index >= def.max) return null

    const last = i === segs.length - 1
    if (last) {
      if (!isField(def)) return null // a group carries no value
      return {
        path: container,
        name: def.name,
        index: seg.index,
        def,
        canonical: formatPath(segs),
      }
    }

    if (def.children.length === 0) return null // cannot descend into a leaf
    container.push({ name: def.name, index: seg.index })
    level = def.children
  }

  return null
}
