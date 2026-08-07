import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import { resolveSchema } from '../model/schema'
import { normalizeTree } from '../model/annotations'

// The test environment provides no localStorage (settings.ts's safeGet/safeSet
// guard for exactly that), but the reviewer-selection persistence tests below
// need a real one to observe — stand one up before importing the store.
if (typeof globalThis.localStorage === 'undefined') {
  const backing = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
    },
    configurable: true,
  })
}

/**
 * Multiple independent reviewers, reconciled by Consolidation. This file pins
 * the routing rule everything else in the feature depends on
 * (`currentTree`/`setFieldValue`/etc. in store.ts):
 *
 *   - single-reviewer → `paper.annotations`, unchanged from before this
 *     feature existed (the backward-compatibility bar the brief sets).
 *   - a numbered reviewer → their own `paper.reviews[N]`, present as an empty
 *     skeleton from the moment the project loads (`normalizeReviews` in
 *     project.ts backfills every reviewer 1..N so a git diff of a reviewer's
 *     first real edit is a value change, not a new key appearing) — not
 *     created lazily on first write, though `currentTree`'s `create` path
 *     still exists as a defensive fallback if one is somehow still missing.
 *   - Consolidation → `paper.annotations`, the tree that actually ships.
 *   - multi-reviewer, nobody picked yet → nothing is read or written; the
 *     reviewer must pick first, never silently default to Reviewer 1.
 *
 * Plus: selecting a reviewer is a view switch (no undo step, no `dirty`), and
 * the selection is persisted per project.
 */

const mockPlatform = {
  kind: 'browser' as const,
  getOsInfo: () => null,
  getRecents: () => [] as RecentEntry[],
  rememberProject: () => {},
  forgetRecent: () => [] as RecentEntry[],
  checkRecents: async (entries: RecentEntry[]) => entries,
  openProject: async () => null,
  openRecent: async () => null,
  saveProject: async (_text: string, handle: SaveHandle) => handle,
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: '' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore, currentTree } = await import('./store')

const schema = [
  { name: 'Study Type', type: 'string' as const },
  { name: 'Relevant', type: 'boolean' as const },
  { name: 'Findings', min: 1, max: null, children: [{ name: 'Claim', type: 'string' as const }] },
]

const singleReviewerProject = JSON.stringify({
  version: 1,
  config: { schema },
  papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
})

/** The empty skeleton every reviewer's tree starts as, once loaded. */
const emptyTree = () => normalizeTree(resolveSchema(schema), undefined)

const multiReviewerProject = JSON.stringify({
  version: 1,
  config: { schema, reviewers: 3 },
  papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
})

const st = () => useStore.getState()
const handleAt = (path: string): SaveHandle => ({ kind: 'electron', path })

beforeEach(() => {
  localStorage.clear()
})

describe('single-reviewer projects are unaffected', () => {
  beforeEach(() => {
    st().loadFromText(singleReviewerProject, null, 'test.json')
    st().selectPaper('p1')
  })

  it('never leaves currentReviewer null', () => {
    expect(st().currentReviewer).toBeNull()
  })

  it('routes reads and writes straight to paper.annotations', () => {
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    expect(st().project!.papers[0].annotations['Study Type'][0].value).toBe('RCT')
    expect(st().project!.papers[0].reviews).toEqual({})
  })
})

describe('multi-reviewer: nobody picked yet', () => {
  beforeEach(() => {
    st().loadFromText(multiReviewerProject, null, 'test.json')
    st().selectPaper('p1')
  })

  it('starts unselected rather than defaulting to Reviewer 1', () => {
    expect(st().currentReviewer).toBeNull()
  })

  it('refuses to write anywhere until a reviewer is picked', () => {
    // Every reviewer's tree already exists (see `emptyTree`) — the refused
    // write must leave every one of them exactly as it was, none created,
    // none touched.
    const before = st().project!.papers[0].reviews
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    expect(st().project!.papers[0].annotations['Study Type'][0].value).toBeNull()
    expect(st().project!.papers[0].reviews).toEqual({ '1': emptyTree(), '2': emptyTree(), '3': emptyTree() })
    expect(st().project!.papers[0].reviews).toBe(before) // not even a new object
    expect(st().dirty).toBe(false)
  })

  it('currentTree reports null for both read and write', () => {
    const paper = st().project!.papers[0]
    expect(currentTree(st().project!, null, paper)).toBeNull()
    expect(currentTree(st().project!, null, paper, true)).toBeNull()
  })
})

describe('multi-reviewer: a numbered reviewer', () => {
  beforeEach(() => {
    st().loadFromText(multiReviewerProject, null, 'test.json')
    st().selectPaper('p1')
    st().selectReviewer('2')
  })

  it('writes into their own paper.reviews[N], leaving annotations and other reviewers untouched', () => {
    st().setFieldValue([], 'Study Type', 0, 'Reviewer 2 says RCT')
    const paper = st().project!.papers[0]
    expect(paper.reviews['2']['Study Type'][0].value).toBe('Reviewer 2 says RCT')
    expect(paper.annotations['Study Type'][0].value).toBeNull()
    // Reviewer 1 already has a tree (loaded, not lazily created) — just an
    // untouched one, not an absent one.
    expect(paper.reviews['1']).toEqual(emptyTree())
  })

  it('writes into a tree that already existed from load, not one it just created', () => {
    // The skeleton is there from the moment the project loads — writing to it
    // updates a value on an existing tree, it does not bring the tree itself
    // into being. `currentTree`'s lazy-create path still exists (see its own
    // doc comment) as a fallback, but the ordinary path no longer needs it.
    const before = st().project!.papers[0].reviews['2']
    expect(before).toEqual(emptyTree())
    st().setFieldValue([], 'Relevant', 0, true)
    const after = st().project!.papers[0].reviews['2']
    expect(after['Relevant'][0].value).toBe(true)
    // Padded to schema min like any freshly-normalized tree, not just the one
    // field that was actually written — unsurprising, since it was already
    // padded before this write touched it.
    expect(after['Study Type']).toHaveLength(1)
    expect(after['Findings']).toHaveLength(1)
  })

  it('reading before writing shows the same well-formed empty tree that was there all along', () => {
    const paper = st().project!.papers[0]
    const read = currentTree(st().project!, '3', paper)
    expect(read!['Relevant'][0].value).toBe(false)
    // Reading did not need to create anything — reviewer 3's tree is already
    // there, unchanged, before and after.
    expect(paper.reviews['3']).toEqual(emptyTree())
    expect(read).toBe(paper.reviews['3']) // the live tree itself, not a copy
  })

  it('add/removeInstance route the same way', () => {
    const def = st().project!.schema[2] // Findings (repeatable)
    st().addInstance([], def)
    expect(st().project!.papers[0].reviews['2'].Findings).toHaveLength(2)
    expect(st().project!.papers[0].annotations.Findings).toHaveLength(1)

    st().removeInstance([], 'Findings', 1)
    expect(st().project!.papers[0].reviews['2'].Findings).toHaveLength(1)
  })

  it('undo/redo still work, scoped to the reviewer tree that was edited', () => {
    st().setFieldValue([], 'Study Type', 0, 'X')
    st().undo()
    expect(st().project!.papers[0].reviews['2']?.['Study Type']?.[0]?.value ?? null).toBeNull()
  })
})

// Bug: `removeInstance` shifted `mark.linkedFields`/`aiMarks`/`paper.equal`/
// `deferredConsolidations` when a repeatable entry was deleted, but never
// touched `paper.alignment` — the record of which reviewer's entry sits in
// which consolidated slot. Left unfixed, every slot at or above the removed
// index kept pointing at the entry that used to be there, misattributing
// reviewer answers to the wrong slot in every compare popup from then on.
describe('multi-reviewer: deleting a repeatable entry shifts alignment (Bug 1)', () => {
  const findingsDef = () => st().project!.schema[2] // Findings (repeatable)

  beforeEach(() => {
    st().loadFromText(multiReviewerProject, null, 'test.json')
    st().selectPaper('p1')

    // Reviewers 1 and 2 each record the same two findings, in the same
    // order, so the matcher's exact-text similarity lines slot 0 up with
    // "Alpha" and slot 1 up with "Beta" deterministically.
    for (const reviewer of ['1', '2']) {
      st().selectReviewer(reviewer)
      st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'Alpha')
      st().addInstance([], findingsDef())
      st().setFieldValue([{ name: 'Findings', index: 1 }], 'Claim', 0, 'Beta')
    }

    st().alignConsolidationNode('p1', 'Findings', false)
  })

  it('lines up the fixture the rest of this block assumes', () => {
    const alignment = st().project!.papers[0].alignment.Findings
    expect(alignment).toEqual([{ members: { '1': 0, '2': 0 } }, { members: { '1': 1, '2': 1 } }])
  })

  it("a reviewer deleting their own entry shifts only their own slot memberships", () => {
    st().selectReviewer('1')
    st().removeInstance([], 'Findings', 0)

    const alignment = st().project!.papers[0].alignment.Findings
    // Reviewer 1's entry at the removed slot is gone, not left dangling...
    expect(alignment[0].members['1']).toBeUndefined()
    // ...and their entry above it shifted down to follow the same real entry.
    expect(alignment[1].members['1']).toBe(0)
    // Reviewer 2 never touched anything here — their memberships are exactly
    // what they were.
    expect(alignment[0].members['2']).toBe(0)
    expect(alignment[1].members['2']).toBe(1)

    // A subsequent read attributes the right reviewer value to the right
    // slot: reviewer 1's sole remaining entry ("Beta") now projects into
    // slot 1, not slot 0.
    const reviewer1Tree = st().project!.papers[0].reviews['1']
    expect(reviewer1Tree.Findings[0].value ?? null).toBeNull()
    expect(reviewer1Tree.Findings[0].children?.Claim[0]?.value).toBe('Beta')
  })

  it('the consolidator deleting a consolidated entry drops that slot, not the array positions', () => {
    st().selectReviewer('consolidation')
    // The consolidated tree was grown to one entry per slot by
    // `alignConsolidationNode` above; delete the first of them.
    st().removeInstance([], 'Findings', 0)

    const alignment = st().project!.papers[0].alignment.Findings
    // Slot 0 (Alpha) is gone entirely — not decremented, spliced — so slot
    // numbering keeps tracking the now-shorter consolidated array.
    expect(alignment).toHaveLength(1)
    // What used to be slot 1 (Beta) is untouched: its members still name the
    // reviewers' own, unmoved indices.
    expect(alignment[0].members).toEqual({ '1': 1, '2': 1 })
  })
})

// Bug: a node the consolidator already answered under was frozen against
// *any* re-matching, including simply adding a reviewer who had no slot
// assignment at all yet (one added to the project later, or one who just
// hadn't started this paper). Their real answers sat in their own tree
// forever, invisible to every compare popup and dropped from agreement
// stats.
describe('multi-reviewer: a late reviewer is added to a frozen node (Bug 4)', () => {
  beforeEach(() => {
    st().loadFromText(multiReviewerProject, null, 'test.json')
    st().selectPaper('p1')

    // Reviewers 1 and 2 agree on one finding; reviewer 3 has not started.
    for (const reviewer of ['1', '2']) {
      st().selectReviewer(reviewer)
      st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'Shared finding')
    }
    st().alignConsolidationNode('p1', 'Findings', false)

    // The consolidator commits an answer, freezing the node — the whole
    // point of `consolidatorHasAnswered`.
    st().selectReviewer('consolidation')
    st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'Consolidated answer')
  })

  it('refuses to re-match once the consolidator has answered (sanity check on the freeze itself)', () => {
    st().selectReviewer('1')
    st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'Changed my mind')
    expect(st().alignConsolidationNode('p1', 'Findings', false)).toBe(false)
    // Frozen means frozen: the existing pairing is untouched even though a
    // fresh match would now see different text.
    expect(st().project!.papers[0].alignment.Findings[0].members).toEqual({ '1': 0, '2': 0 })
  })

  it('places a reviewer who had no slot at all once they finally answer', () => {
    st().selectReviewer('3')
    st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'Shared finding')

    expect(st().alignConsolidationNode('p1', 'Findings', false)).toBe(true)

    const alignment = st().project!.papers[0].alignment.Findings
    // The existing pairing the consolidator already answered against is
    // untouched...
    expect(alignment[0].members['1']).toBe(0)
    expect(alignment[0].members['2']).toBe(0)
    // ...and reviewer 3, previously absent from every slot, is now placed.
    expect(alignment[0].members['3']).toBe(0)
  })
})

describe('multi-reviewer: Consolidation', () => {
  beforeEach(() => {
    st().loadFromText(multiReviewerProject, null, 'test.json')
    st().selectPaper('p1')
    st().selectReviewer('consolidation')
  })

  it('reads and writes paper.annotations — the tree that ships', () => {
    const reviewsBefore = st().project!.papers[0].reviews
    st().setFieldValue([], 'Study Type', 0, 'Final answer')
    const paper = st().project!.papers[0]
    expect(paper.annotations['Study Type'][0].value).toBe('Final answer')
    // The reviewers' own trees (present from load, all empty) are untouched
    // by a Consolidation write — same reference, not just an equal value.
    expect(paper.reviews).toBe(reviewsBefore)
  })

  // Was 'stores a selected reviewer value and marks the disagreement resolved
  // in one undo step', and asserted `paper.equal` gained 'Study Type'. That
  // locked in a real bug: picking a reviewer's answer is the normal, routine
  // act of consolidating, not a declaration that the reviewers agreed. `equal`
  // feeds straight into Cohen's kappa/Fleiss' kappa/Krippendorff's alpha (see
  // `disagreements.ts`/`agreement.ts`), so every resolved disagreement was
  // quietly inflating the very statistic this feature exists to report
  // honestly. Only the explicit "these answers mean the same thing" checkbox
  // (`toggleFieldEquality`) may set it now.
  it('stores a selected reviewer value in one undo step, without marking it agreed', () => {
    st().resolveConsolidationValue([], 'Study Type', 0, 'Reviewer 1 value')

    const paper = st().project!.papers[0]
    expect(paper.annotations['Study Type'][0].value).toBe('Reviewer 1 value')
    expect(paper.equal).not.toContain('Study Type')
    expect(st().past).toHaveLength(1)
  })

  // Was '...then resolves it', and asserted `paper.equal` gained 'Study Type'
  // once the deferred value was filled in — the same bug as above, reached
  // through the deferred-value path instead of the compare popup.
  it('keeps a different-value field pending until Consolidation fills it, without marking it agreed', () => {
    st().deferConsolidationValue([], 'Study Type', 0)
    expect(st().deferredConsolidations['p1::Study Type']).toBe(true)
    expect(st().project!.papers[0].equal).not.toContain('Study Type')

    st().setFieldValue([], 'Study Type', 0, 'A third value')

    const paper = st().project!.papers[0]
    expect(st().deferredConsolidations['p1::Study Type']).toBeUndefined()
    expect(paper.annotations['Study Type'][0].value).toBe('A third value')
    expect(paper.equal).not.toContain('Study Type')
  })

  it('the explicit "these answers mean the same thing" checkbox still sets equal', () => {
    st().toggleFieldEquality('p1', 'Study Type')
    expect(st().project!.papers[0].equal).toContain('Study Type')
  })

  it('clears equal when a consolidation-seat edit leaves the field empty', () => {
    st().toggleFieldEquality('p1', 'Study Type')
    expect(st().project!.papers[0].equal).toContain('Study Type')

    st().setFieldValue([], 'Study Type', 0, '')

    expect(st().project!.papers[0].equal).not.toContain('Study Type')
  })
})

describe('selecting a reviewer is a view switch, not an edit', () => {
  beforeEach(() => {
    st().loadFromText(multiReviewerProject, null, 'test.json')
    st().selectPaper('p1')
  })

  it('does not set dirty', () => {
    st().selectReviewer('1')
    expect(st().dirty).toBe(false)
  })

  it('is not an undo step', () => {
    st().selectReviewer('1')
    st().setFieldValue([], 'Study Type', 0, 'X')
    expect(st().past).toHaveLength(1)
    st().selectReviewer('2')
    expect(st().past).toHaveLength(1) // unchanged — the switch pushed nothing
    st().undo()
    expect(st().currentReviewer).toBe('2') // undo restores data, not the selection
    expect(st().project!.papers[0].reviews['1']?.['Study Type']?.[0]?.value ?? null).toBeNull()
  })
})

describe('reviewer selection is persisted per project', () => {
  it('restores the selection when the same project (by save-handle path) is reopened', () => {
    st().loadFromText(multiReviewerProject, handleAt('/reviews/x.json'), 'x.json')
    st().selectReviewer('consolidation')

    st().closeProject()
    expect(st().currentReviewer).toBeNull()

    st().loadFromText(multiReviewerProject, handleAt('/reviews/x.json'), 'x.json')
    expect(st().currentReviewer).toBe('consolidation')
  })

  it('does not leak a selection across two different projects', () => {
    st().loadFromText(multiReviewerProject, handleAt('/reviews/a.json'), 'a.json')
    st().selectReviewer('2')

    st().loadFromText(multiReviewerProject, handleAt('/reviews/b.json'), 'b.json')
    expect(st().currentReviewer).toBeNull()
  })

  it('ignores a persisted selection that no longer fits (reviewer count shrank)', () => {
    st().loadFromText(multiReviewerProject, handleAt('/reviews/x.json'), 'x.json')
    st().selectReviewer('3')

    const twoReviewers = JSON.stringify({
      version: 1,
      config: { schema, reviewers: 2 },
      papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
    })
    st().loadFromText(twoReviewers, handleAt('/reviews/x.json'), 'x.json')
    expect(st().currentReviewer).toBeNull()
  })

  it('does not persist anything for a project with no stable handle (no path)', () => {
    st().loadFromText(multiReviewerProject, null, 'test.json')
    expect(() => st().selectReviewer('1')).not.toThrow()
    st().loadFromText(multiReviewerProject, null, 'test.json')
    expect(st().currentReviewer).toBeNull()
  })

  it('a single-reviewer project never persists or restores a selection', () => {
    st().loadFromText(singleReviewerProject, handleAt('/reviews/single.json'), 'single.json')
    expect(st().currentReviewer).toBeNull()
    st().closeProject()
    st().loadFromText(singleReviewerProject, handleAt('/reviews/single.json'), 'single.json')
    expect(st().currentReviewer).toBeNull()
  })
})

describe('closeProject resets the reviewer view', () => {
  it('clears currentReviewer and any open compare popup', () => {
    st().loadFromText(multiReviewerProject, null, 'test.json')
    st().selectPaper('p1')
    st().selectReviewer('consolidation')
    st().openConsolidation([], 'Study Type', 0)
    expect(st().consolidationTarget).not.toBeNull()

    st().closeProject()
    expect(st().currentReviewer).toBeNull()
    expect(st().consolidationTarget).toBeNull()
  })
})

describe('returning from a disagreement comparison', () => {
  beforeEach(() => {
    st().loadFromText(multiReviewerProject, null, 'test.json')
    st().selectPaper('p1')
    st().selectReviewer('consolidation')
  })

  it('reopens the current paper disagreement list when it launched the comparison', () => {
    st().setDisagreementsOpen(true)
    st().openConsolidation([], 'Study Type', 0, true)
    st().setDisagreementsOpen(false)

    st().closeConsolidation()

    expect(st().consolidationTarget).toBeNull()
    expect(st().disagreementsOpen).toBe(true)
    expect(st().returnToDisagreements).toBe(false)
  })

  it('does not open the disagreement list after an ordinary field comparison', () => {
    st().openConsolidation([], 'Study Type', 0)
    st().closeConsolidation()

    expect(st().disagreementsOpen).toBe(false)
  })

  it('restores the overview after closing a paper disagreement list opened there', () => {
    st().setConsolidationOverviewOpen(true)
    st().openDisagreementsFromOverview('p1')

    expect(st().currentPaperId).toBe('p1')
    expect(st().consolidationOverviewOpen).toBe(false)
    expect(st().disagreementsOpen).toBe(true)

    st().closeDisagreements()

    expect(st().disagreementsOpen).toBe(false)
    expect(st().consolidationOverviewOpen).toBe(true)
    expect(st().disagreementsReturnToOverview).toBe(false)
  })

  it('keeps the overview hidden until a field comparison returns to and closes its paper list', () => {
    st().setConsolidationOverviewOpen(true)
    st().openDisagreementsFromOverview('p1')
    st().openConsolidation([], 'Study Type', 0, true)
    st().setDisagreementsOpen(false)

    st().closeConsolidation()

    expect(st().disagreementsOpen).toBe(true)
    expect(st().consolidationOverviewOpen).toBe(false)
    expect(st().disagreementsReturnToOverview).toBe(true)

    st().closeDisagreements()
    expect(st().consolidationOverviewOpen).toBe(true)
  })

  it('replaces the overview with Agreement and restores it when Agreement closes', () => {
    st().setConsolidationOverviewOpen(true)
    st().openAgreementFromOverview()

    expect(st().consolidationOverviewOpen).toBe(false)
    expect(st().agreementOpen).toBe(true)

    st().closeAgreement()

    expect(st().agreementOpen).toBe(false)
    expect(st().consolidationOverviewOpen).toBe(true)
  })
})

describe('switching reviewer breaks undo-coalescing (no cross-reviewer data loss)', () => {
  beforeEach(() => {
    st().loadFromText(multiReviewerProject, null, 'test.json')
    st().selectPaper('p1')
  })

  it('a single Undo after editing the same field as two reviewers keeps the first reviewer', () => {
    // Regression: the coalescing key is field-path only (no seat), so without
    // resetting it on `selectReviewer`, R2's edit to the same field glued onto
    // R1's undo step — one Undo wiped both, and retyping cleared `future`,
    // losing R1's answer for good.
    st().selectReviewer('1')
    st().setFieldValue([], 'Study Type', 0, 'A')
    st().selectReviewer('2')
    st().setFieldValue([], 'Study Type', 0, 'B')

    st().undo() // undoes only R2's edit

    expect(st().project!.papers[0].reviews['1']['Study Type'][0].value).toBe('A')
    expect(st().project!.papers[0].reviews['2']['Study Type'][0].value).toBeNull()
  })

  it('jumping to another paper from the Consolidation overview also resets the coalescing key', () => {
    // Regression: openDisagreementsFromOverview switched currentPaperId without
    // resetting lastFieldKey, so an edit to the same field name on the new
    // paper glued onto the previous paper's undo step — one Undo wiped both
    // papers' answers, and retyping cleared `future`, losing the first paper's
    // answer for good.
    const twoPapers = JSON.stringify({
      version: 1,
      config: { schema, reviewers: 3 },
      papers: [
        { id: 'p1', title: 'T1', authors: [], pdf: 'a.pdf', annotations: {} },
        { id: 'p2', title: 'T2', authors: [], pdf: 'b.pdf', annotations: {} },
      ],
    })
    st().loadFromText(twoPapers, null, 'test.json')
    st().selectPaper('p1')
    st().selectReviewer('consolidation')
    st().setFieldValue([], 'Study Type', 0, 'A')

    st().setConsolidationOverviewOpen(true)
    st().openDisagreementsFromOverview('p2')
    st().closeDisagreements()
    st().setFieldValue([], 'Study Type', 0, 'B')

    st().undo() // should undo only p2's edit

    expect(st().project!.papers[1].annotations['Study Type'][0].value).toBeNull()
    expect(st().project!.papers[0].annotations['Study Type'][0].value).toBe('A')
  })
})
