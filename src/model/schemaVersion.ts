import type { AnnotationValueTree, InstanceNode } from './annotations'
import { instanceHoldsAnswer } from './annotations'
import type { ResolvedDef } from './schema'
import type { PdfMark } from './pdfMarks'
import { formatPath, parsePath } from '../llm/paths'

/**
 * Versions of the annotation schema, and the renames and moves between them.
 *
 * Every saved schema change gets a new `schemaVersion` id, recorded in
 * `schemaHistory` with the id(s) it replaced and the nodes the project editor
 * renamed or moved. Each annotation file records the version it was written
 * under, so an answer written before a rename — including by a reviewer who
 * had not pulled it yet — is carried to the node's new name when the file is
 * read, rather than left behind as a hidden answer.
 *
 * Answers are stored under node names, so a node's identity *is* its name
 * path; a rename or move is recorded as `from` → `to` name paths.
 */

export interface SchemaMove {
  from: string[]
  to: string[]
}

export interface SchemaHistoryEntry {
  id: string
  /** The version(s) this one replaced: none for the first, two after a merge. */
  parents: string[]
  /** ISO 8601. */
  at: string
  moves: SchemaMove[]
  /**
   * Versions folded into this one while they were still private — edited
   * again before anyone else could have seen them (see `amendVersion`) — with
   * how many of `moves` each had. A file stamped with one of them has seen
   * exactly those first moves.
   */
  absorbed?: { id: string; moves: number }[]
}

const isNames = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s !== '')

/** Defensive: a hand-edited or damaged history drops the entries it cannot read. */
export function parseSchemaHistory(raw: unknown): SchemaHistoryEntry[] {
  if (!Array.isArray(raw)) return []
  const out: SchemaHistoryEntry[] = []
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue
    const { id, parents, at, moves } = e as Record<string, unknown>
    if (typeof id !== 'string' || id === '') continue
    const absorbed = Array.isArray((e as { absorbed?: unknown }).absorbed)
      ? ((e as { absorbed: unknown[] }).absorbed.flatMap((a) => {
          const { id: aid, moves: n } = (a ?? {}) as Record<string, unknown>
          return typeof aid === 'string' && typeof n === 'number' && n >= 0 ? [{ id: aid, moves: Math.floor(n) }] : []
        }))
      : []
    out.push({
      id,
      ...(absorbed.length > 0 ? { absorbed } : {}),
      parents: Array.isArray(parents) ? parents.filter((p): p is string => typeof p === 'string') : [],
      at: typeof at === 'string' ? at : '',
      moves: Array.isArray(moves)
        ? moves.flatMap((m) => {
            const { from, to } = (m ?? {}) as Record<string, unknown>
            return isNames(from) && isNames(to) ? [{ from, to }] : []
          })
        : [],
    })
  }
  return out
}

export function parseSchemaVersion(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw : null
}

/** `id` and every version it descends from. */
export function ancestorsOf(history: SchemaHistoryEntry[], id: string): Set<string> {
  const byId = new Map(history.map((e) => [e.id, e]))
  const seen = new Set<string>()
  const stack = [id]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const a of byId.get(cur)?.absorbed ?? []) seen.add(a.id)
    for (const p of byId.get(cur)?.parents ?? []) stack.push(p)
  }
  return seen
}

/** The entry that absorbed `id`, and how many of its moves `id` had. */
function absorbedInto(history: SchemaHistoryEntry[], id: string): { entry: SchemaHistoryEntry; seen: number } | null {
  for (const entry of history) {
    const a = entry.absorbed?.find((x) => x.id === id)
    if (a) return { entry, seen: a.moves }
  }
  return null
}

/**
 * Fold `moves` into the current version instead of starting a new one. Used
 * while the current version has not left this machine, so the history does not
 * gain an entry for every save. It still gets a new id: files already stamped
 * with the old one have seen only its first moves, and must get the rest.
 */
export function amendVersion(
  history: SchemaHistoryEntry[],
  current: string,
  moves: SchemaMove[],
  at: string,
): { id: string; history: SchemaHistoryEntry[] } | null {
  const i = history.findIndex((e) => e.id === current)
  if (i < 0) return null
  const e = history[i]
  const id = newSchemaVersionId()
  const entry: SchemaHistoryEntry = {
    id,
    parents: e.parents,
    at,
    moves: [...e.moves, ...moves],
    absorbed: [...(e.absorbed ?? []), { id: e.id, moves: e.moves.length }],
  }
  return { id, history: [...history.slice(0, i), entry, ...history.slice(i + 1)] }
}

/**
 * The moves a file written under `fileVersion` has not seen yet, in history
 * order — or `'unknown'` when the project's history does not know that version
 * (a file from a branch with a different schema, or edited by hand), which
 * leaves the file as it is.
 *
 * `null` means the file predates versioning, so every recorded move is newer
 * than it; `undefined` means it is already at the project's version.
 */
export function pendingMoves(
  history: SchemaHistoryEntry[],
  fileVersion: string | null | undefined,
  current: string | null,
): SchemaMove[] | 'unknown' {
  if (fileVersion === undefined || fileVersion === current) return []
  if (fileVersion === null) return history.flatMap((e) => e.moves)
  const folded = absorbedInto(history, fileVersion)
  if (folded) {
    const seen = ancestorsOf(history, folded.entry.id)
    return history.flatMap((e) =>
      e === folded.entry ? e.moves.slice(folded.seen) : seen.has(e.id) ? [] : e.moves,
    )
  }
  if (!history.some((e) => e.id === fileVersion)) return 'unknown'
  const seen = ancestorsOf(history, fileVersion)
  return history.filter((e) => !seen.has(e.id)).flatMap((e) => e.moves)
}

/** Where `from` and `to` stop sharing names. */
function commonPrefix(from: string[], to: string[]): number {
  let c = 0
  while (c < from.length - 1 && c < to.length - 1 && from[c] === to[c]) c++
  return c
}

/** Pull out the node at `path`, through single-instance levels only. */
function take(tree: AnnotationValueTree, path: string[]): { rest: AnnotationValueTree; node: InstanceNode[] } | null {
  const [head, ...tail] = path
  const arr = tree[head]
  if (!Array.isArray(arr)) return null
  if (tail.length === 0) {
    const { [head]: node, ...rest } = tree
    return { rest, node }
  }
  if (arr.length !== 1 || !arr[0].children) return null
  const inner = take(arr[0].children, tail)
  if (!inner) return null
  return { rest: { ...tree, [head]: [{ ...arr[0], children: inner.rest }] }, node: inner.node }
}

/** Put `node` at `path`, creating single-instance levels as needed; `null`
 *  when the way there is through a repeated entry, or the spot holds answers. */
function put(tree: AnnotationValueTree, path: string[], node: InstanceNode[]): AnnotationValueTree | null {
  const [head, ...tail] = path
  const arr = tree[head]
  if (tail.length === 0) {
    if (Array.isArray(arr) && arr.some(instanceHoldsAnswer)) return null
    return { ...tree, [head]: node }
  }
  const inst = Array.isArray(arr) && arr.length > 0 ? arr : [{ children: {} }]
  if (inst.length !== 1) return null
  const inner = put(inst[0].children ?? {}, tail, node)
  return inner ? { ...tree, [head]: [{ ...inst[0], children: inner }] } : null
}

/**
 * Apply one move to an annotation tree. Below the part of the path the two
 * share, the answers can only be carried through single entries — which of
 * several repeated entries would an answer land in? — so a move that would
 * need that, or would land on answers already there, leaves the tree as it
 * is and the old answers stay hidden.
 */
export function moveInTree(tree: AnnotationValueTree | undefined, move: SchemaMove): AnnotationValueTree | undefined {
  if (!tree) return tree
  const c = commonPrefix(move.from, move.to)
  const walk = (t: AnnotationValueTree, depth: number): AnnotationValueTree => {
    if (depth < c) {
      const arr = t[move.from[depth]]
      if (!Array.isArray(arr)) return t
      return {
        ...t,
        [move.from[depth]]: arr.map((inst) => (inst.children ? { ...inst, children: walk(inst.children, depth + 1) } : inst)),
      }
    }
    const taken = take(t, move.from.slice(depth))
    if (!taken) return t
    return put(taken.rest, move.to.slice(depth), taken.node) ?? t
  }
  return walk(tree, 0)
}

/** Apply one move to the field links of PDF marks, under the same rule. */
export function moveInMarks(marks: PdfMark[], move: SchemaMove): PdfMark[] {
  const c = commonPrefix(move.from, move.to)
  let changed = false
  const next = marks.map((m) => {
    if (!m.linkedFields) return m
    const linkedFields = m.linkedFields.map((l) => {
      const segs = parsePath(l.path)
      if (!segs || segs.length < move.from.length) return l
      if (!move.from.every((name, i) => segs[i].name === name)) return l
      if (segs.slice(c, move.from.length - 1).some((s) => s.index !== 0)) return l
      changed = true
      const moved = [
        ...segs.slice(0, c),
        ...move.to.slice(c).map((name, i, all) => ({
          name,
          index: i === all.length - 1 ? segs[move.from.length - 1].index : 0,
        })),
        ...segs.slice(move.from.length),
      ]
      return { ...l, path: formatPath(moved) }
    })
    return { ...m, linkedFields }
  })
  return changed ? next : marks
}

/** Apply one move to a schema (the merge brings both sides to one history). */
export function moveInDefs(defs: ResolvedDef[], move: SchemaMove): ResolvedDef[] {
  const find = (list: ResolvedDef[], path: string[]): ResolvedDef | undefined => {
    const d = list.find((x) => x.name === path[0])
    return path.length === 1 ? d : d && find(d.children, path.slice(1))
  }
  const node = find(defs, move.from)
  if (!node || find(defs, move.to)) return defs
  const without = (list: ResolvedDef[], path: string[]): ResolvedDef[] =>
    path.length === 1
      ? list.filter((d) => d.name !== path[0])
      : list.map((d) => (d.name === path[0] ? { ...d, children: without(d.children, path.slice(1)) } : d))
  const withNode = (list: ResolvedDef[], path: string[]): ResolvedDef[] | null => {
    if (path.length === 1) return [...list, { ...node, name: path[0] }]
    let placed = false
    const out = list.map((d) => {
      if (d.name !== path[0]) return d
      const children = withNode(d.children, path.slice(1))
      if (!children) return d
      placed = true
      return { ...d, children }
    })
    return placed ? out : null
  }
  return withNode(without(defs, move.from), move.to) ?? defs
}

/** Both sides' histories, ours' order first. */
export function mergeHistories(ours: SchemaHistoryEntry[], theirs: SchemaHistoryEntry[]): SchemaHistoryEntry[] {
  const ids = new Set(ours.map((e) => e.id))
  return [...ours, ...theirs.filter((e) => !ids.has(e.id))]
}

/** A new version id. */
export function newSchemaVersionId(): string {
  return crypto.randomUUID()
}
