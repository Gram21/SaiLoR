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

/**
 * A backslash introduces an escape **only** when the next character is one this
 * format punctuates (`/ [ ]`) or a backslash itself; anywhere else it is a
 * literal backslash. That asymmetry is deliberate and load-bearing: the old
 * format allowed a bare `\` inside a name and passed it through verbatim, so a
 * field named `Cost\Benefit` already has canonical strings persisted as
 * `Cost\Benefit` — in `paper.equal` marks and AI-mark keys. Escaping every
 * backslash unconditionally would re-canonicalise it to `Cost\\Benefit`,
 * silently orphaning those marks and making `resolvePath` fail on the stored
 * ones. Under this rule such a name still escapes to itself, so *every* name
 * that worked before this module learned to escape still round-trips to the
 * identical string.
 */
function needsEscape(ch: string | undefined): boolean {
  return ch !== undefined && ESCAPABLE.has(ch)
}

function escapeName(name: string): string {
  let out = ''
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]
    if (ch === '/' || ch === '[' || ch === ']') {
      out += `\\${ch}`
      continue
    }
    // Only a backslash that would otherwise *read* as an escape has to be
    // escaped — i.e. one immediately before an escapable character.
    if (ch === '\\' && needsEscape(name[i + 1])) {
      out += '\\\\'
      continue
    }
    out += ch
  }
  return out
}

/** One decoded character and whether it arrived escaped — enough to find the
 *  `[n]` suffix without re-deriving escape state from backslash counting. */
interface DecodedChar {
  ch: string
  escaped: boolean
}

function decode(part: string): DecodedChar[] {
  const out: DecodedChar[] = []
  for (let i = 0; i < part.length; i++) {
    if (part[i] === '\\' && needsEscape(part[i + 1])) {
      out.push({ ch: part[i + 1], escaped: true })
      i++
      continue
    }
    out.push({ ch: part[i], escaped: false })
  }
  return out
}

/** Split on unescaped "/" only, keeping escape sequences intact for the
 *  per-segment parser. */
function splitSegments(raw: string): string[] {
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\' && needsEscape(raw[i + 1])) {
      cur += ch + raw[i + 1]
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
  // path. Trimming the raw text (not the decoded characters) matches what the
  // pre-escaping parser did, so ordinary paths parse identically.
  const decoded = decode(part.trim())

  // A trailing, *unescaped* `[digits]` is an index suffix; anything else is
  // part of the name.
  let nameEnd = decoded.length
  let index = 0
  const last = decoded[decoded.length - 1]
  if (last && last.ch === ']' && !last.escaped) {
    let i = decoded.length - 2
    let digits = ''
    while (i >= 0 && !decoded[i].escaped && decoded[i].ch >= '0' && decoded[i].ch <= '9') {
      digits = decoded[i].ch + digits
      i--
    }
    if (digits !== '' && i >= 0 && decoded[i].ch === '[' && !decoded[i].escaped) {
      nameEnd = i
      index = Number(digits)
    }
  }

  // A `[` or `]` still standing unescaped inside the name is malformed, exactly
  // as before escaping existed ("A[", "A[x]", "A[-1]", "A[]" are all rejected).
  // Only the escaped forms are a legitimate part of a name, so a path that
  // ignores the format cannot quietly resolve to something.
  let name = ''
  for (let i = 0; i < nameEnd; i++) {
    const d = decoded[i]
    if (!d.escaped && (d.ch === '[' || d.ch === ']')) return null
    name += d.ch
  }
  // The pre-escaping parser trimmed the name again after stripping the index
  // suffix, so "Findings [1]" yielded "Findings". Kept for byte-compatibility;
  // a name whose own padding matters was never representable in this format.
  name = name.trim()

  if (name === '') return null
  if (!Number.isSafeInteger(index) || index < 0) return null
  return { name, index }
}

/** Split "A[1]/B" into segments. Returns null when the syntax is malformed. */
export function parsePath(raw: string): RawSeg[] | null {
  if (typeof raw !== 'string') return null
  const parts = splitSegments(raw)
  if (parts.length === 0) return null

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
    .map((seg) => {
      const name = escapeName(seg.name)
      if (seg.index === 0) return name
      // A name ending in a backslash would swallow the suffix's '[' as an
      // escape, so double it. Only reachable for a name that actually ends in
      // one — every other name is untouched.
      const safe = name.endsWith('\\') ? `${name}\\` : name
      return `${safe}[${seg.index}]`
    })
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
