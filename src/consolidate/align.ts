import type { AnnotationValueTree, InstanceNode } from '../model/annotations'
import type { ResolvedDef } from '../model/schema'
import { isField } from '../model/schema'
import { maxWeightAssignment } from './assign'
import {
  agreementMass,
  combine,
  valueSimilarity,
  type Sim,
  type TextSimCache,
  NO_EVIDENCE,
} from './similarity'

/**
 * Work out which of each reviewer's repeated entries are *the same entry*.
 *
 * Two reviewers annotating one paper both record, say, three Findings — but
 * nothing makes them record them in the same order. Reviewer 1's Finding #1 may
 * be Reviewer 2's Finding #3. Comparing them slot by slot would then report
 * disagreement everywhere and be worse than useless. This module recovers the
 * correspondence first, so the comparison is between entries that are actually
 * about the same thing.
 *
 * Two properties matter, and both fall out of the shape of the algorithm rather
 * than being enforced afterwards:
 *
 * **Matching is optimal, not greedy.** Each node's entries are paired by
 * `maxWeightAssignment`, which maximises total agreement over the whole set
 * (see `assign.ts` for why greedy is not merely worse but wrong).
 *
 * **Matching is hierarchical, so it cannot cross.** A group's sub-entries are
 * only ever matched *inside* an already-matched pair of parents. There is no
 * point at which Finding A could pair with Finding B while A's Evidence pairs
 * with C's — the recursion never offers C as a candidate. The consistency the
 * feature requires is structural, not a rule applied after the fact.
 */

/** One consolidated entry, and which reviewer entry each side contributed. */
export interface AlignedSlot {
  /** Reviewer id → the index of their entry in their *own* array. */
  members: Record<string, number>
  /** Alignments for this slot's repeated children — matched within this pair. */
  children: TreeAlignment
  /** 0..1, how much the members agree. Drives the UI, not the matching. */
  agreement: number
  /** How much evidence `agreement` rests on: 0 means the entries are silent. */
  evidence: number
}

export interface NodeAlignment {
  /**
   * As many slots as the most prolific reviewer has entries — the count the
   * consolidated tree is grown to.
   */
  slots: AlignedSlot[]
  /** How many entries each reviewer recorded, so the UI can flag a mismatch. */
  counts: Record<string, number>
}

/** Node name → its alignment, for one level of the tree. */
export type TreeAlignment = Record<string, NodeAlignment>

/**
 * Nudges an otherwise tied pairing towards the order the reviewers already used.
 * Two entries that share no comparable content give the matcher nothing to go
 * on, and it would be free to shuffle them arbitrarily; small enough that any
 * real agreement outranks it.
 */
const ORDER_TIE_BREAK = 1e-6

/**
 * What an entry earns by opening a brand-new slot instead of being forced into
 * an existing one it shares no evidence with. Smaller than `ORDER_TIE_BREAK`,
 * so a same-position pairing with zero evidence still wins that slot (the old,
 * harmless behavior for two blank entries in the same relative order) — but
 * larger than the zero mass of being forced into an unrelated slot, so an entry
 * that genuinely matches nothing gets its own slot rather than corrupting one
 * that belongs to someone else's entry. See `alignList`.
 */
const NEW_SLOT_WEIGHT = ORDER_TIE_BREAK / 10

/** A node holds several entries, so its entries need matching at all. */
export function isRepeatable(def: ResolvedDef): boolean {
  return def.max === null || def.max > 1
}

/**
 * How alike two entries of the same node are.
 *
 * Recursive, because a group is only as alike as its contents: a Finding is
 * compared through its Claim and its Evidence, and its Evidence — itself
 * repeatable — is compared by solving the smaller matching problem first. The
 * cost therefore builds bottom-up, which is also why nested groups match
 * sensibly rather than by their top-level fields alone.
 *
 * Not worth memoising on the entry pair, which is the obvious thing to try and
 * measurably does nothing: the matcher asks about each pair of entries roughly
 * once, so there is no repetition at this level to collect. The repetition is
 * all in the text underneath — see `TextSimCache`, which is what `cache` is.
 */
function instanceSim(
  def: ResolvedDef,
  a: InstanceNode | undefined,
  b: InstanceNode | undefined,
  cache: TextSimCache,
): Sim {
  if (!a || !b) return NO_EVIDENCE

  const parts: Sim[] = []
  if (isField(def)) parts.push(valueSimilarity(def, a.value, b.value, cache))

  for (const child of def.children) {
    const listA = a.children?.[child.name] ?? []
    const listB = b.children?.[child.name] ?? []
    parts.push(
      isRepeatable(child)
        ? listSim(child, listA, listB, cache)
        : instanceSim(child, listA[0], listB[0], cache),
    )
  }
  return combine(parts)
}

/**
 * How alike two *lists* of entries are: match them optimally, then judge the
 * pairs that matching produced.
 *
 * Entries left over (one reviewer recorded four, the other three) are not
 * counted against the pair. That is the same rule an unanswered field follows —
 * see `Sim` — and for the same reason: a reviewer recording less says nothing
 * about whether what they *did* record is the same thing.
 */
function listSim(
  def: ResolvedDef,
  listA: InstanceNode[],
  listB: InstanceNode[],
  cache: TextSimCache,
): Sim {
  if (listA.length === 0 || listB.length === 0) return NO_EVIDENCE

  const sims = listA.map((a) => listB.map((b) => instanceSim(def, a, b, cache)))
  const weights = sims.map((row) => row.map(agreementMass))
  const rowToCol = maxWeightAssignment(weights)

  const matched: Sim[] = []
  rowToCol.forEach((col, row) => {
    if (col >= 0) matched.push(sims[row][col])
  })
  return combine(matched)
}

/** Average agreement between one entry and the entries already in a slot. */
function simAgainstSlot(
  def: ResolvedDef,
  entry: InstanceNode | undefined,
  slot: AlignedSlot,
  lists: Record<string, InstanceNode[]>,
  cache: TextSimCache,
): Sim {
  const parts: Sim[] = []
  for (const [reviewer, index] of Object.entries(slot.members)) {
    parts.push(instanceSim(def, entry, lists[reviewer]?.[index], cache))
  }
  const merged = combine(parts)
  // Per *member*, not summed over them. `combine` averages the score but adds
  // the weights up, and the assignment maximises score × weight — so a slot two
  // reviewers had already landed in scored roughly twice a slot holding one,
  // and outbid it even at strictly worse agreement. With three reviewers, one
  // of whom recorded fewer entries than the anchor, an exact match could be
  // pulled into a crowded slot while the identical anchor entry it belonged
  // with was left alone at agreement 0. Dividing by the member count makes
  // slots comparable no matter how full they are, which is what "how well does
  // this entry fit this slot" was always supposed to mean.
  //
  // Only two reviewers means every slot holds exactly one member, so the bias
  // cancels and nothing about the two-reviewer case changes.
  const n = parts.length
  return n > 1 ? { ...merged, weight: merged.weight / n } : merged
}

function newSlot(): AlignedSlot {
  return { members: {}, children: {}, agreement: 0, evidence: 0 }
}

/**
 * Build the slots for one repeatable node across every reviewer.
 *
 * Matching N reviewers at once is the multi-dimensional assignment problem,
 * which is NP-hard and would be absurd for the sizes involved. Instead the
 * reviewer with the most entries anchors the slots — they are the one who
 * seeds the first ones — and everyone else is matched onto those slots in
 * turn. Later reviewers are matched against *all* members already in a slot,
 * not just the anchor, so a slot's identity firms up as reviewers agree on it.
 *
 * An entry a reviewer records that genuinely matches none of the slots seen so
 * far (no evidence of overlap with any of them) opens a new slot of its own
 * instead of being forced into whichever existing one the assignment problem
 * has left over — see `NEW_SLOT_WEIGHT`. Reviewer A recording three findings
 * and Reviewer B recording two, one of which A never wrote down, ends up with
 * four slots, not three: A's third finding and B's unmatched one both stand on
 * their own, ready for the consolidator to verify or discard, rather than
 * silently smeared into "disagreement" on some unrelated slot. A later
 * reviewer can still land in a slot a previous one opened this way — new
 * slots join the same array everyone after them matches against.
 *
 * The order reviewers are folded in is fixed (most entries first, then by id) so
 * the same input always produces the same alignment. An alignment that shifted
 * between runs would reorder saved data for no reason.
 *
 * Slot order is otherwise the anchor's own list order, with newly-opened slots
 * appended after it — never reshuffled by how well a slot matches. Position N
 * naming the same entry for everyone across a save and reload (see
 * `applyAlignment`'s doc comment) depends on that order being stable; a
 * "matched first" resort would change which index a reviewer's own entries
 * land on for reasons having nothing to do with what they recorded.
 */
function alignList(
  def: ResolvedDef,
  lists: Record<string, InstanceNode[]>,
  cache: TextSimCache,
): NodeAlignment {
  const reviewers = Object.keys(lists).sort(
    (x, y) => lists[y].length - lists[x].length || compareReviewerIds(x, y),
  )
  const counts: Record<string, number> = {}
  for (const r of reviewers) counts[r] = lists[r].length

  if (reviewers.every((r) => lists[r].length === 0)) return { slots: [], counts }

  const [anchor, ...rest] = reviewers
  const slots: AlignedSlot[] = lists[anchor].map((_, i) => {
    const slot = newSlot()
    slot.members[anchor] = i
    return slot
  })

  for (const reviewer of rest) {
    const entries = lists[reviewer]
    if (entries.length === 0) continue
    const baseSlotCount = slots.length
    const weights = entries.map((entry, i) => {
      const row = slots.map((slot, s) => {
        const sim = simAgainstSlot(def, entry, slot, lists, cache)
        // The order nudge only applies when the slot has nothing to go on
        // either (`sim.weight === 0`, the same "no evidence" `NO_EVIDENCE`
        // means elsewhere): with real evidence a slot's mass of exactly 0 is
        // a genuine "definitely not this one", and must not be dressed up as
        // a tie just because the entry sits at that slot's index — see
        // `NEW_SLOT_WEIGHT`, which needs that case to actually lose.
        const tieBreak = sim.weight === 0 && i === s ? ORDER_TIE_BREAK : 0
        return agreementMass(sim) + tieBreak
      })
      // One "open a new slot" column per entry — interchangeable, so it does
      // not matter which entry lands on which; each still starts its own slot.
      for (let j = 0; j < entries.length; j++) row.push(NEW_SLOT_WEIGHT)
      return row
    })
    maxWeightAssignment(weights).forEach((col, entryIndex) => {
      if (col < 0) return
      if (col < baseSlotCount) {
        slots[col].members[reviewer] = entryIndex
        return
      }
      const slot = newSlot()
      slot.members[reviewer] = entryIndex
      slots.push(slot)
    })
  }

  for (const slot of slots) {
    scoreSlot(def, slot, lists, cache)
    slot.children = alignLevel(
      def.children,
      mapMembers(slot, lists, (inst) => inst?.children),
      cache,
    )
  }

  return { slots, counts }
}

/** Every distinct pair in a slot, averaged — how much its members agree. */
function scoreSlot(
  def: ResolvedDef,
  slot: AlignedSlot,
  lists: Record<string, InstanceNode[]>,
  cache: TextSimCache,
): void {
  const members = Object.entries(slot.members)
  const parts: Sim[] = []
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const [rx, ix] = members[i]
      const [ry, iy] = members[j]
      parts.push(instanceSim(def, lists[rx]?.[ix], lists[ry]?.[iy], cache))
    }
  }
  const sim = combine(parts)
  slot.agreement = sim.score
  slot.evidence = sim.weight
}

/** Pull one value per member out of the reviewer entries a slot points at. */
function mapMembers<T>(
  slot: AlignedSlot,
  lists: Record<string, InstanceNode[]>,
  pick: (inst: InstanceNode | undefined) => T,
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [reviewer, index] of Object.entries(slot.members)) {
    out[reviewer] = pick(lists[reviewer]?.[index])
  }
  return out
}

/**
 * Align every node at one level of the schema.
 *
 * Non-repeatable nodes still appear when they have children: they hold no
 * choice of their own, but a repeatable node may be nested below one, and it
 * has to be reachable.
 */
function alignLevel(
  defs: ResolvedDef[],
  trees: Record<string, AnnotationValueTree | undefined>,
  cache: TextSimCache,
): TreeAlignment {
  const out: TreeAlignment = {}
  for (const def of defs) {
    const lists: Record<string, InstanceNode[]> = {}
    for (const [reviewer, tree] of Object.entries(trees)) {
      const raw = tree?.[def.name]
      lists[reviewer] = Array.isArray(raw) ? raw : []
    }

    if (isRepeatable(def)) {
      out[def.name] = alignList(def, lists, cache)
      continue
    }
    if (def.children.length === 0) continue // a plain field: nothing to match

    // Fixed single entry: the correspondence is a given, but its children still
    // need aligning.
    const slot: AlignedSlot = { members: {}, children: {}, agreement: 0, evidence: 0 }
    const counts: Record<string, number> = {}
    for (const [reviewer, list] of Object.entries(lists)) {
      counts[reviewer] = list.length
      if (list.length > 0) slot.members[reviewer] = 0
    }
    scoreSlot(def, slot, lists, cache)
    slot.children = alignLevel(
      def.children,
      mapMembers(slot, lists, (inst) => inst?.children),
      cache,
    )
    out[def.name] = { slots: [slot], counts }
  }
  return out
}

/** Reviewer ids are numeric strings ("1".."N"); sort them as numbers. */
function compareReviewerIds(x: string, y: string): number {
  const nx = Number(x)
  const ny = Number(y)
  if (Number.isFinite(nx) && Number.isFinite(ny)) return nx - ny
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * Align every reviewer's tree for one paper.
 *
 * `reviews` is keyed by reviewer id and must *exclude* the consolidated tree:
 * consolidation is the thing being built from this, not a voice in it.
 */
export function alignPaper(
  schema: ResolvedDef[],
  reviews: Record<string, AnnotationValueTree>,
): TreeAlignment {
  return alignLevel(schema, reviews, new Map())
}

/**
 * Align one top-level node, returning an alignment shaped like a whole-paper
 * one but holding only that node — `applyAlignment` skips what it does not find,
 * so a partial result applies as-is.
 *
 * The unit the scheduler works in. A node is independent of its siblings, so
 * doing them one at a time is what lets the work be spread across frames and
 * the node the reviewer is actually looking at be pulled to the front.
 */
export function alignNode(
  schema: ResolvedDef[],
  reviews: Record<string, AnnotationValueTree>,
  nodeName: string,
): TreeAlignment {
  const def = schema.find((d) => d.name === nodeName)
  if (!def) return {}
  return alignLevel([def], reviews, new Map())
}

/**
 * The nodes worth aligning: those holding several entries, or with a repeatable
 * node somewhere beneath them. Everything else has one entry per reviewer and
 * nothing to match.
 */
export function alignableNodes(schema: ResolvedDef[]): string[] {
  return schema.filter(hasAnythingToMatch).map((d) => d.name)
}

function hasAnythingToMatch(def: ResolvedDef): boolean {
  return isRepeatable(def) || def.children.some(hasAnythingToMatch)
}
