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

/**
 * `/`, `[` and `]` are this format's own punctuation, so a node *name*
 * containing one has to be escaped with a backslash (and a literal backslash
 * doubled) or the path stops meaning what it says. Field names like
 * "Population / Setting", "Cost/Benefit" or "Ref [see note]" are ordinary SLR
 * codebook names and nothing rejects them, so before escaping existed a name
 * with a "/" in it round-tripped into two *different* segments — resolving to
 * a different field, or to none at all. That is not cosmetic: `changes.ts` and
 * `merge.ts` write a reviewer's answer to whatever `resolvePath` returns, so a
 * git commit could land an answer in the wrong field, and an unresolvable name
 * made its field permanently uncommittable (the "use" write silently no-ops,
 * and the next scan re-detects the same change forever).
 *
 * A name containing none of these characters escapes to itself, so the
 * canonical form of every ordinary path is byte-identical to what this module
 * produced before — which matters, because those strings are *persisted*: they
 * key `paper.equal` (the consolidator's "these mean the same thing" marks) and
 * are compared against stored values. Existing files keep working untouched.
 */
const ESCAPABLE = new Set(['\\', '/', '[', ']'])

function escapeName(name: string): string {
  let out = ''
  for (const ch of name) out += ESCAPABLE.has(ch) ? `\\${ch}` : ch
  return out
}

function unescapeName(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      out += s[i + 1]
      i++
    } else {
      out += s[i]
    }
  }
  return out
}

/** Split on unescaped "/" only, keeping escape sequences intact for the
 *  per-segment parser. Returns null on a dangling trailing backslash. */
function splitSegments(raw: string): string[] | null {
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\') {
      const next = raw[i + 1]
      if (next === undefined) return null
      cur += `\\${next}`
      i++
      continue
    }
    if (ch === '/') {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts
}

/** One segment: a (possibly escaped) name with an optional unescaped `[n]`. */
function parseSegment(part: string): RawSeg | null {
  // Trimmed for tolerance of "A / B" spacing in a hand-written or model-written
  // path; genuine leading/trailing spaces in a name are normalised away by
  // `resolveSchema`, so nothing legitimate is lost here.
  const trimmed = part.trim()
  let namePart = trimmed
  let index = 0

  const m = /\[(\d+)\]$/.exec(trimmed)
  if (m) {
    const bracketAt = trimmed.length - m[0].length
    // Only a `[` that is not itself escaped opens an index suffix.
    let backslashes = 0
    for (let i = bracketAt - 1; i >= 0 && trimmed[i] === '\\'; i--) backslashes++
    if (backslashes % 2 === 0) {
      namePart = trimmed.slice(0, bracketAt)
      index = Number(m[1])
    }
  }

  // A `[` or `]` still standing unescaped in the name is malformed, exactly as
  // before escaping existed ("A[", "A[x]", "A[-1]", "A[]" are all rejected).
  // Only the escaped forms are a legitimate part of a name, so a path that
  // ignores the format cannot quietly resolve to something.
  for (let i = 0; i < namePart.length; i++) {
    if (namePart[i] === '\\') {
      i++
      continue
    }
    if (namePart[i] === '[' || namePart[i] === ']') return null
  }

  const name = unescapeName(namePart)
  if (name === '') return null
  if (!Number.isSafeInteger(index) || index < 0) return null
  return { name, index }
}

/** Split "A[1]/B" into segments. Returns null when the syntax is malformed. */
export function parsePath(raw: string): RawSeg[] | null {
  if (typeof raw !== 'string') return null
  const parts = splitSegments(raw)
  if (parts === null || parts.length === 0) return null

  const segs: RawSeg[] = []
  for (const part of parts) {
    const seg = parseSegment(part)
    if (!seg) return null
    segs.push(seg)
  }
  return segs
}

/** Canonical text form. Index 0 is left implicit, so paths compare stably. */
export function formatPath(segs: RawSeg[]): string {
  return segs
    .map((s) => (s.index === 0 ? escapeName(s.name) : `${escapeName(s.name)}[${s.index}]`))
    .join('/')
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
