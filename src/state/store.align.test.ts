import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'

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
 * `alignConsolidationNode`: the store side of matching the reviewers' repeated
 * entries. The matching itself is pinned in `consolidate/*.test.ts`; what this
 * file cares about is how the result lands in the project — the undo entry, the
 * dirty flag, and that a paper nobody can be matched against is left alone.
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

const { useStore } = await import('./store')

const schema = [
  { name: 'Study Type', type: 'string' as const },
  { name: 'Relevant', type: 'boolean' as const },
  {
    name: 'Findings',
    min: 1,
    max: null,
    children: [
      { name: 'Claim', type: 'string' as const },
      { name: 'Evidence', type: 'string' as const },
    ],
  },
]

const finding = (claim: string) => ({ children: { Claim: [{ value: claim }] } })

/** Two reviewers who recorded the same findings in opposite orders. */
function projectText(reviewers: number, reviews: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    config: { schema, reviewers },
    papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {}, reviews }],
  })
}

const swapped = {
  '1': { Findings: [finding('Alpha'), finding('Beta'), finding('Gamma')] },
  '2': { Findings: [finding('Gamma'), finding('Alpha'), finding('Beta')] },
}

const TEST_USAGE = { provider: 'anthropic', model: 'claude-5' }

const st = () => useStore.getState()
const claimsOf = (reviewer: string) =>
  (st().project!.papers[0].reviews[reviewer]['Findings'] ?? []).map(
    (f) => f.children?.['Claim']?.[0]?.value ?? null,
  )

beforeEach(() => {
  localStorage.clear()
})

describe('alignConsolidationNode', () => {
  beforeEach(() => {
    st().loadFromText(projectText(2, swapped), null, 'test.json')
    st().selectPaper('p1')
    st().selectReviewer('consolidation')
  })

  it('lines the reviewers up and grows the consolidated tree', () => {
    expect(st().alignConsolidationNode('p1', 'Findings', false)).toBe(true)
    expect(claimsOf('1')).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(claimsOf('2')).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(st().project!.papers[0].annotations['Findings']).toHaveLength(3)
  })

  it('marks the project dirty, because it changed saved data', () => {
    expect(st().dirty).toBe(false)
    st().alignConsolidationNode('p1', 'Findings', false)
    expect(st().dirty).toBe(true)
  })

  it('is one undo press', () => {
    st().alignConsolidationNode('p1', 'Findings', false)
    expect(st().past).toHaveLength(1)
    st().undo()
    expect(claimsOf('2')).toEqual(['Gamma', 'Alpha', 'Beta'])
  })

  it('folds a coalescing node into the run\'s existing undo entry', () => {
    // What the scheduler does for the second and later nodes of one paper, so
    // lining a paper up is a single undo rather than one press per node.
    st().alignConsolidationNode('p1', 'Findings', false)
    const depth = st().past.length
    st().alignConsolidationNode('p1', 'Study Type', true)
    expect(st().past.length).toBe(depth)
  })

  it('reports no change, and takes no undo step, when already lined up', () => {
    st().alignConsolidationNode('p1', 'Findings', false)
    const depth = st().past.length
    expect(st().alignConsolidationNode('p1', 'Findings', false)).toBe(false)
    expect(st().past.length).toBe(depth)
  })

  it('does nothing to a single-reviewer project', () => {
    st().loadFromText(
      JSON.stringify({
        version: 1,
        config: { schema },
        papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
      }),
      null,
      'test.json',
    )
    st().selectPaper('p1')
    expect(st().alignConsolidationNode('p1', 'Findings', false)).toBe(false)
    expect(st().dirty).toBe(false)
  })

  it('does nothing when only one reviewer has recorded anything', () => {
    // There is no second opinion to match against, and reordering one
    // reviewer's list against nothing would be noise.
    st().loadFromText(
      projectText(3, { '1': { Findings: [finding('Alpha'), finding('Beta')] } }),
      null,
      'test.json',
    )
    st().selectPaper('p1')
    st().selectReviewer('consolidation')
    expect(st().alignConsolidationNode('p1', 'Findings', false)).toBe(false)
    expect(st().dirty).toBe(false)
  })

  it('ignores an unknown paper or node rather than throwing', () => {
    expect(st().alignConsolidationNode('nope', 'Findings', false)).toBe(false)
    expect(st().alignConsolidationNode('p1', 'Not A Node', false)).toBe(false)
  })

  it('does not let a later keystroke merge into the alignment\'s undo entry', () => {
    // `setFieldValue` coalesces consecutive edits of one field; an edit landing
    // right after an alignment must not join that entry and become un-undoable
    // on its own.
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    st().alignConsolidationNode('p1', 'Findings', false)
    const depth = st().past.length
    st().setFieldValue([], 'Study Type', 0, 'RCTX')
    expect(st().past.length).toBe(depth + 1)
  })

  it('leaves the consolidator\'s own entries alone', () => {
    st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'My own call')
    st().alignConsolidationNode('p1', 'Findings', false)
    const consolidated = st().project!.papers[0].annotations['Findings']
    expect(consolidated[0].children?.['Claim']?.[0]?.value).toBe('My own call')
  })

  it('will not re-match a node the consolidator has already answered', () => {
    // The dangerous case. Reviewer 1 anchors, so the slots come out
    // [Alpha, Beta] and the consolidator commits an answer to slot 0 meaning
    // Alpha. If Reviewer 2 then records more entries and takes over as anchor,
    // a fresh match would reorder both reviewers underneath that answer — slot
    // 0 would hold something else while still reading "Alpha agreed". The
    // consolidator's answer would silently describe the wrong finding.
    st().alignConsolidationNode('p1', 'Findings', false)
    expect(claimsOf('1')).toEqual(['Alpha', 'Beta', 'Gamma'])
    st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'Alpha agreed')

    useStore.setState((s) => {
      s.project!.papers[0].reviews['2']['Findings'] = [
        finding('Zeta'),
        finding('Omega'),
        finding('Beta'),
        finding('Alpha'),
      ]
    })

    expect(st().alignConsolidationNode('p1', 'Findings', false)).toBe(false)
    // Slot 0 still means Alpha for everyone, exactly as it did when the
    // consolidator answered it.
    expect(claimsOf('1')[0]).toBe('Alpha')
    expect(
      st().project!.papers[0].annotations['Findings'][0].children?.['Claim']?.[0]?.value,
    ).toBe('Alpha agreed')
  })

  it('still matches a node the consolidator has not answered yet', () => {
    // The guard is per node, not per paper: answering one node must not freeze
    // the rest of the paper.
    st().alignConsolidationNode('p1', 'Study Type', false)
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    expect(st().alignConsolidationNode('p1', 'Findings', false)).toBe(true)
    expect(claimsOf('2')).toEqual(['Alpha', 'Beta', 'Gamma'])
  })
})

describe('adoptUnanimousValues', () => {
  const agreed = {
    '1': {
      'Study Type': [{ value: 'Controlled experiment' }],
      Findings: [finding('Alpha'), finding('Beta')],
    },
    '2': {
      // Same answers, typed differently — case and stray space are not a
      // disagreement.
      'Study Type': [{ value: '  controlled  Experiment ' }],
      Findings: [finding('Beta'), finding('Alpha')],
    },
  }

  const markOf = (canonical: string) =>
    st().aiMarks[`p1::consolidation::${canonical}`] === true

  beforeEach(() => {
    st().loadFromText(projectText(2, agreed), null, 'test.json')
    st().selectPaper('p1')
    st().selectReviewer('consolidation')
  })

  it('adopts what both reviewers said, keeping the first one\'s wording', () => {
    expect(st().adoptUnanimousValues('p1', false)).toBeGreaterThan(0)
    expect(st().project!.papers[0].annotations['Study Type'][0].value).toBe('Controlled experiment')
  })

  it('marks each adopted field the way an AI fill is marked', () => {
    st().adoptUnanimousValues('p1', false)
    expect(markOf('Study Type')).toBe(true)
  })

  it('marks under the Consolidation seat, so the border shows there', () => {
    // `useAiMark` scopes by the *current* reviewer on a multi-reviewer project;
    // a mark written under any other scope would simply never render.
    st().adoptUnanimousValues('p1', false)
    expect(Object.keys(st().aiMarks).every((k) => k.startsWith('p1::consolidation::'))).toBe(true)
  })

  it('adopts across matched entries once they are lined up', () => {
    // Reviewer 2 listed the findings in the opposite order, so before matching
    // there is no agreement at index 0 at all. Afterwards there is.
    expect(st().adoptUnanimousValues('p1', false)).toBe(1) // Study Type only
    st().alignConsolidationNode('p1', 'Findings', false)
    st().adoptUnanimousValues('p1', false)
    const consolidated = st().project!.papers[0].annotations['Findings']
    expect(consolidated[0].children?.['Claim']?.[0]?.value).toBe('Alpha')
    expect(consolidated[1].children?.['Claim']?.[0]?.value).toBe('Beta')
  })

  it('does not touch a field the reviewers disagree on', () => {
    st().loadFromText(
      projectText(2, {
        '1': { 'Study Type': [{ value: 'Case study' }] },
        '2': { 'Study Type': [{ value: 'Survey' }] },
      }),
      null,
      'test.json',
    )
    st().selectPaper('p1')
    st().selectReviewer('consolidation')
    expect(st().adoptUnanimousValues('p1', false)).toBe(0)
    expect(st().project!.papers[0].annotations['Study Type'][0].value).toBeNull()
    expect(st().dirty).toBe(false)
  })

  it('does not overwrite the consolidator\'s own answer', () => {
    st().setFieldValue([], 'Study Type', 0, 'My own call')
    st().adoptUnanimousValues('p1', false)
    expect(st().project!.papers[0].annotations['Study Type'][0].value).toBe('My own call')
  })

  it('is one undo press, and reverts the values', () => {
    st().adoptUnanimousValues('p1', false)
    expect(st().past).toHaveLength(1)
    st().undo()
    expect(st().project!.papers[0].annotations['Study Type'][0].value).toBeNull()
  })

  it('takes no undo step and does nothing when there is no agreement', () => {
    st().adoptUnanimousValues('p1', false)
    const depth = st().past.length
    // Everything unanimous is already adopted, so a second run finds nothing.
    expect(st().adoptUnanimousValues('p1', false)).toBe(0)
    expect(st().past.length).toBe(depth)
  })

  it('does nothing on a single-reviewer project', () => {
    st().loadFromText(
      JSON.stringify({
        version: 1,
        config: { schema },
        papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
      }),
      null,
      'test.json',
    )
    st().selectPaper('p1')
    expect(st().adoptUnanimousValues('p1', false)).toBe(0)
    expect(st().dirty).toBe(false)
  })
})

describe('AI is not usable from the Consolidation seat', () => {
  beforeEach(() => {
    st().loadFromText(projectText(2, {}), null, 'test.json')
    st().selectPaper('p1')
  })

  it('refuses to apply suggestions into the consolidated tree', () => {
    // The panel hides the button, so the only way here is to open the dialog as
    // a reviewer and switch seats. The store must refuse regardless of the UI:
    // this tree is the final result, and a model is not one of the opinions
    // being reconciled.
    st().selectReviewer('consolidation')
    const result = st().applyAiSuggestions(
      [{ path: 'Study Type', value: 'RCT', evidence: 'q', confidence: 1 }],
      TEST_USAGE,
    )
    expect(result).toEqual({ filled: 0, skipped: 1 })
    expect(st().project!.papers[0].annotations['Study Type'][0].value).toBeNull()
    expect(st().dirty).toBe(false)
  })

  it('still applies them for a numbered reviewer', () => {
    st().selectReviewer('1')
    expect(
      st().applyAiSuggestions(
        [{ path: 'Study Type', value: 'RCT', evidence: 'q', confidence: 1 }],
        TEST_USAGE,
      ).filled,
    ).toBe(1)
  })
})
