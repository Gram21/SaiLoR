import type { AnnotationValueTree, InstanceNode } from '../model/annotations'
import type { ResolvedDef } from '../model/schema'
import { isField } from '../model/schema'
import type { StoredAlignment, StoredSlot } from '../model/alignment'
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
 * Work out which of each reviewer's repeated entries are *the same entry*,
 * since reviewers need not record them in the same order (Reviewer 1's
 * Finding #1 may be Reviewer 2's Finding #3) — comparing slot by slot would
 * report disagreement everywhere.
 *
 * Matching is optimal, not greedy: entries are paired by `maxWeightAssignment`,
 * which maximises total agreement (see `assign.ts` for why greedy is wrong).
 * Matching is also hierarchical and so cannot cross: sub-entries are only
 * matched *inside* an already-matched pair of parents, never across parents.
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
 * Nudges an otherwise-tied pairing towards the reviewers' original order, when
 * entries share no comparable content and the matcher would otherwise shuffle
 * them arbitrarily. Small enough that any real agreement outranks it.
 */
const ORDER_TIE_BREAK = 1e-6

/**
 * What an entry earns by opening a new slot instead of being forced into one
 * it doesn't belong in. Smaller than `ORDER_TIE_BREAK` (so a same-position
 * zero-evidence pairing still wins its slot) but larger than a rejected
 * pairing's zero (so an unmatched entry gets its own slot). See `alignList`.
 */
const NEW_SLOT_WEIGHT = ORDER_TIE_BREAK / 10

/**
 * How alike two entries must be before they count as *the same entry*.
 *
 * Without a floor, `maxWeightAssignment` maximises total agreement and would
 * always pair leftovers rather than leave them unmatched at 0 — silently
 * merging a reviewer's unique finding into whatever entry was left, reported
 * as a disagreement rather than two separate findings.
 *
 * `score > 0.5` ("strictly more alike than different"), not `>=`: at exactly
 * half the evidence is a coin flip, and a coin flip reads as "two things".
 *
 * The trade-off is one-directional by design: splitting a real pair is
 * visible and fixable by the consolidator; merging two unrelated entries is
 * invisible, indistinguishable from a real disagreement. This errs toward the
 * mistake a human can see (cf. `fieldUsage.ts` warning rather than migrating).
 *
 * ponytail: flat threshold over crude text similarity, so heavy paraphrase
 * (~0.31 similarity) splits into two slots. Upgrade path is a better
 * `stringSimilarity` (embeddings, stemming) — not lowering this number, which
 * would re-admit the false pairings the floor exists to stop.
 */
const MIN_MATCH_SCORE = 0.5

/**
 * Degenerate case: a childless repeatable node where nobody recorded more
 * than one entry. There's exactly one way to pair these, so `MIN_MATCH_SCORE`
 * has nothing to protect against — refusing the pair would instead produce
 * two half-empty slots where one plain disagreement (e.g. "Benchmark" vs
 * "Case study") belongs.
 *
 * Restricted to childless nodes: with sub-fields, "one entry each" doesn't
 * mean "one thing each" — two single Findings could genuinely differ, which
 * is the invisible mistake `MIN_MATCH_SCORE` guards against. Groups that
 * actually agree on most sub-fields already clear the threshold on their own.
 */
function singlePairing(def: ResolvedDef, lists: Record<string, InstanceNode[]>): boolean {
  return def.children.length === 0 && Object.values(lists).every((l) => l.length <= 1)
}

/** A node holds several entries, so its entries need matching at all. */
export function isRepeatable(def: ResolvedDef): boolean {
  return def.max === null || def.max > 1
}

/**
 * How alike two entries of the same node are. Recursive and bottom-up: a
 * Finding is compared through its Claim and Evidence, with Evidence's own
 * repeated entries matched first — so nested groups match on their contents,
 * not just their top-level fields.
 *
 * Not worth memoising on the entry pair: each pair is asked about once, so
 * there's no repetition here to collect. The repetition is in the text
 * underneath — see `TextSimCache` (`cache`).
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
 * resulting pairs. Leftover entries (unequal list lengths) aren't counted
 * against the pair — same rule as an unanswered field (see `Sim`): recording
 * less says nothing about whether what *was* recorded matches.
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
  // Divide by member count: `combine` sums weights, so a fuller slot would
  // otherwise outbid an emptier one on weight alone, even at worse agreement,
  // pulling entries into crowded slots instead of their real match. With only
  // two reviewers every slot holds one member, so this is a no-op there.
  const n = parts.length
  return n > 1 ? { ...merged, weight: merged.weight / n } : merged
}

function newSlot(): AlignedSlot {
  return { members: {}, children: {}, agreement: 0, evidence: 0 }
}

/**
 * Build the slots for one repeatable node across every reviewer.
 *
 * Matching N reviewers at once is NP-hard, so instead the reviewer with the
 * most entries anchors the slots and everyone else is folded in against those
 * slots in turn, matched against *all* members already in a slot (not just
 * the anchor) so a slot's identity firms up as reviewers agree on it.
 *
 * An entry matching none of the slots seen so far opens a new slot rather
 * than being forced into a leftover one (see `NEW_SLOT_WEIGHT`) — so an
 * unmatched finding stands on its own for the consolidator, instead of being
 * smeared into "disagreement" on an unrelated slot. Later reviewers can still
 * land in a slot opened this way.
 *
 * Fold-in order is fixed (most entries first, then by id) for reproducible
 * output. Slot order is the anchor's list order plus new slots appended after
 * — never reshuffled by match quality, since position N must keep naming the
 * same entry across save/reload (see `applyAlignment`).
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

  if (singlePairing(def, lists)) {
    const slot = newSlot()
    for (const r of reviewers) if (lists[r].length > 0) slot.members[r] = 0
    scoreSlot(def, slot, lists, cache)
    return { slots: [slot], counts }
  }

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
        // Nothing comparable either way: no grounds to pair them and none to
        // separate them, so fall back to the order the reviewers already used.
        if (sim.weight === 0) return i === s ? ORDER_TIE_BREAK : 0
        // Not the same entry (see `MIN_MATCH_SCORE`) — score 0, not the real
        // mass, so the new-slot column below can win instead.
        if (sim.score <= MIN_MATCH_SCORE) return 0
        return agreementMass(sim)
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
 * Non-repeatable nodes with children still appear: a repeatable node may be
 * nested below one, and it has to stay reachable.
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
 * Add reviewers who have no key at all in an already-frozen alignment,
 * without moving anyone who does.
 *
 * `alignConsolidationNode` (store.ts) refuses to recompute a node once the
 * consolidator has committed under it, since a fresh `alignList` run could
 * reshuffle slot N's meaning. But that freeze assumed every reviewer already
 * had some mapping — a reviewer added later has no key anywhere and, without
 * this, would never get one placed into a consolidated slot.
 *
 * Runs the same per-reviewer folding as `alignList`, seeded from the frozen
 * slots instead of fresh ones; existing reviewers' `members[r]` is never
 * touched. Recurses into touched slots' children so nested repeatable entries
 * get placed too, without disturbing already-frozen nested matching.
 *
 * Operates on the stored (persisted) shape, not `TreeAlignment` — there's no
 * live `agreement`/`evidence` to maintain here, only membership.
 */
export function widenAlignment(
  defs: ResolvedDef[],
  existing: StoredAlignment,
  trees: Record<string, AnnotationValueTree | undefined>,
  cache: TextSimCache,
): { alignment: StoredAlignment; changed: boolean } {
  const out: StoredAlignment = {}
  let changed = false

  for (const def of defs) {
    const lists: Record<string, InstanceNode[]> = {}
    for (const [reviewer, tree] of Object.entries(trees)) {
      const raw = tree?.[def.name]
      lists[reviewer] = Array.isArray(raw) ? raw : []
    }
    const existingSlots = existing[def.name]
    if (!existingSlots) continue // never frozen here; a full alignment will handle it

    if (isRepeatable(def)) {
      const widened = widenList(def, existingSlots, lists, cache)
      out[def.name] = widened.slots
      if (widened.changed) changed = true
      continue
    }
    if (def.children.length === 0) continue // a plain field: nothing to place

    // Fixed single entry: only ever one slot. A newcomer with an entry and no
    // assignment yet takes index 0 there, same rule `alignLevel` uses fresh.
    const slot = existingSlots[0] ?? { members: {} }
    const nextMembers = { ...slot.members }
    let memberAdded = false
    for (const [reviewer, list] of Object.entries(lists)) {
      if (nextMembers[reviewer] === undefined && list.length > 0) {
        nextMembers[reviewer] = 0
        memberAdded = true
      }
    }
    const childTrees: Record<string, AnnotationValueTree | undefined> = {}
    for (const [reviewer, index] of Object.entries(nextMembers)) {
      childTrees[reviewer] = lists[reviewer]?.[index]?.children
    }
    const widenedChildren = widenAlignment(def.children, slot.children ?? {}, childTrees, cache)
    const nextSlot: StoredSlot = { members: nextMembers }
    if (Object.keys(widenedChildren.alignment).length > 0) nextSlot.children = widenedChildren.alignment
    out[def.name] = [nextSlot]
    if (memberAdded || widenedChildren.changed) changed = true
  }

  return { alignment: out, changed }
}

/**
 * `widenAlignment`'s repeatable-node case: folds reviewers absent from
 * `existingSlots` in one at a time, using `alignList`'s same matching and
 * new-slot rules — just folding into frozen slots instead of a fresh anchor.
 */
function widenList(
  def: ResolvedDef,
  existingSlots: StoredSlot[],
  lists: Record<string, InstanceNode[]>,
  cache: TextSimCache,
): { slots: StoredSlot[]; changed: boolean } {
  const known = new Set<string>()
  for (const slot of existingSlots) for (const r of Object.keys(slot.members)) known.add(r)

  const newcomers = Object.keys(lists)
    .filter((r) => !known.has(r) && lists[r].length > 0)
    .sort(compareReviewerIds)

  if (newcomers.length === 0) return { slots: existingSlots, changed: false }

  // Same degenerate case `alignList` short-circuits, from the frozen side: one
  // entry apiece and one existing slot leaves the newcomer nowhere else to go.
  if (singlePairing(def, lists) && existingSlots.length === 1) {
    const members = { ...existingSlots[0].members }
    for (const r of newcomers) members[r] = 0
    return { slots: [{ members }], changed: true }
  }

  // Plain member-bag copies — `simAgainstSlot` only reads `.members`;
  // `children` passes through untouched until a slot is actually widened below.
  const slots: StoredSlot[] = existingSlots.map((s) => {
    const slot: StoredSlot = { members: { ...s.members } }
    if (s.children) slot.children = s.children
    return slot
  })
  let changed = false

  for (const reviewer of newcomers) {
    const entries = lists[reviewer]
    const asAlignedSlots: AlignedSlot[] = slots.map((s) => ({
      members: s.members,
      children: {},
      agreement: 0,
      evidence: 0,
    }))
    const baseSlotCount = slots.length
    const weights = entries.map((entry, i) => {
      const row = asAlignedSlots.map((slot, s) => {
        const sim = simAgainstSlot(def, entry, slot, lists, cache)
        if (sim.weight === 0) return i === s ? ORDER_TIE_BREAK : 0
        if (sim.score <= MIN_MATCH_SCORE) return 0
        return agreementMass(sim)
      })
      for (let j = 0; j < entries.length; j++) row.push(NEW_SLOT_WEIGHT)
      return row
    })
    maxWeightAssignment(weights).forEach((col, entryIndex) => {
      if (col < 0) return
      changed = true
      if (col < baseSlotCount) {
        slots[col].members[reviewer] = entryIndex
      } else {
        slots.push({ members: { [reviewer]: entryIndex } })
      }
    })
  }

  // Only recurse into slots a newcomer actually landed in — keeps this a pure
  // widening: untouched slots' frozen nested matching is left as-is.
  if (def.children.length > 0) {
    for (const slot of slots) {
      const touchedByNewcomer = Object.keys(slot.members).some((r) => newcomers.includes(r))
      if (!touchedByNewcomer) continue
      const childTrees: Record<string, AnnotationValueTree | undefined> = {}
      for (const [reviewer, index] of Object.entries(slot.members)) {
        childTrees[reviewer] = lists[reviewer]?.[index]?.children
      }
      const widenedChildren = widenAlignment(def.children, slot.children ?? {}, childTrees, cache)
      if (widenedChildren.changed) {
        slot.children = widenedChildren.alignment
        changed = true
      }
    }
  }

  return { slots, changed }
}

/**
 * Align one top-level node; the result is shaped like a whole-paper alignment
 * but holds only that node, since `applyAlignment` skips what it doesn't find.
 *
 * `reviews` must *exclude* the consolidated tree — it's being built from this,
 * not a voice in it. This is also the unit the scheduler works in: nodes are
 * independent, so aligning one at a time lets work spread across frames.
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
