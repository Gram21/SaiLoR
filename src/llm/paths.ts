import type { ResolvedDef } from '../model/schema'
import { isField } from '../model/schema'

/**
 * Field paths, as used in the LLM contract: node names joined with "/", each
 * optionally indexed to pick one entry of a repeated node (bare name = index 0),
 * e.g. "Findings[1]/Evidence[0]/Metric". An index may name an entry that
 * doesn't exist yet, so resolution checks the **schema**, not current data —
 * the caller creates missing instances when applying.
 */

/** A path split into segments, before it has been checked against a schema. */
export interface RawSeg {
  name: string
  index: number
}

/** Same shape as the store's `PathSeg`; declared here so this module (and the
 *  model code using it, which the Electron main process also loads) does not
 *  depend on the store. */
type PathSeg = RawSeg

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
 * `/`, `[`, `]` are this format's punctuation, so a name containing one must
 * be escaped (backslash-prefixed; literal backslash doubled), or a name like
 * "Cost/Benefit" round-trips into the wrong field — and an unresolvable name
 * makes it permanently uncommittable, since `changes.ts`/`merge.ts` write
 * through whatever `resolvePath` returns.
 *
 * Ordinary names escape to themselves, so canonical strings stay
 * byte-identical to before this existed — they're persisted as `paper.equal`
 * keys and compared against stored values, so existing files keep working.
 */
const ESCAPABLE = new Set(['\\', '/', '[', ']'])

/**
 * A backslash escapes only when followed by punctuation this format uses
 * (`/ [ ]`) or another backslash; elsewhere it's literal. Deliberate: a
 * pre-existing name like `Cost\Benefit` already has canonical strings
 * persisted with a bare backslash, so escaping every backslash unconditionally
 * would re-canonicalise it and orphan those stored marks.
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
  // Trimmed for tolerance of "A / B" spacing; trimming raw text (not decoded
  // chars) matches the pre-escaping parser, so ordinary paths parse identically.
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

  // An unescaped `[` or `]` inside the name is malformed, same as before escaping
  // existed ("A[", "A[x]", "A[-1]" are rejected) — only escaped forms are legal.
  let name = ''
  for (let i = 0; i < nameEnd; i++) {
    const d = decoded[i]
    if (!d.escaped && (d.ch === '[' || d.ch === ']')) return null
    name += d.ch
  }
  // Trimmed again after stripping the index suffix (so "Findings [1]" →
  // "Findings"), kept for byte-compatibility with the pre-escaping parser.
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
      // A name ending in a backslash would swallow the suffix's '[' as an escape,
      // so double it; every other name is untouched.
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
 * Rejects unknown names, non-final segments with no children, a final segment
 * that isn't a field, and any index at or beyond the node's `max` — this is
 * the gate between everything the model sends and the project data.
 */
/**
 * Ceiling for a `max: null` node when the caller opts in — far beyond any
 * hand-authored list, low enough that filling to it won't exhaust memory.
 */
export const MAX_UNBOUNDED_INDEX = 10_000

export interface ResolveOptions {
  /**
   * Reject an index at or beyond this on a node declared `max: null`.
   *
   * Opt-in: only LLM entry points use it, because they *materialize* every
   * instance up to the index (an unbounded reply is an OOM). Applying it
   * everywhere would make resolution silently drop real, already-existing
   * data — e.g. `applyOne` (git/merge.ts) discarding a reviewer's conflict
   * resolution at a legitimately held path instead of erroring.
   */
  maxUnboundedIndex?: number
}

export function resolvePath(
  schema: ResolvedDef[],
  raw: string,
  opts: ResolveOptions = {},
): ResolvedPath | null {
  const segs = parsePath(raw)
  if (!segs || segs.length === 0) return null

  let level: ResolvedDef[] = schema
  const container: PathSeg[] = []

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    // Exact match first; fall back to trimmed comparison for a def name that
    // carries surrounding whitespace (parseSegment trims segments, so "Claim "
    // would otherwise never resolve — the same permanently-uncommittable
    // failure this file's header describes). Safe because resolveSchema
    // forbids two sibling names that trim alike.
    const def =
      level.find((d) => d.name === seg.name) ?? level.find((d) => d.name.trim() === seg.name)
    if (!def) return null

    // `max: null` means unbounded. A ceiling applies only when the caller asks
    // for one — see `ResolveOptions.maxUnboundedIndex`.
    const ceiling = def.max === null ? (opts.maxUnboundedIndex ?? Infinity) : def.max
    if (seg.index >= ceiling) return null

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
