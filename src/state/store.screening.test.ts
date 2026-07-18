import { describe, it, expect, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'

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

const st = () => useStore.getState()

function screeningProject(opts: { reviewers?: number; papers?: unknown[] } = {}) {
  return JSON.stringify({
    version: 1,
    config: {
      screening: { reasons: ['Wrong topic', 'Duplicate'] },
      ...(opts.reviewers ? { reviewers: opts.reviewers } : {}),
    },
    papers: opts.papers ?? [
      { id: 'p1', title: 'Paper One', authors: [], pdf: '', annotations: {} },
      { id: 'p2', title: 'Paper Two', authors: [], pdf: '', annotations: {} },
    ],
  })
}

describe('setScreeningDecision', () => {
  it('writes into the single-reviewer seat\'s annotations tree', () => {
    st().loadFromText(screeningProject(), null, 'test.json')
    st().selectPaper('p1')
    st().setScreeningDecision('Include')
    expect(st().project!.papers[0].annotations.Decision[0].value).toBe('Include')
  })

  it('is refused when multi-reviewer and nobody has picked a seat', () => {
    st().loadFromText(screeningProject({ reviewers: 2 }), null, 'test.json')
    st().selectPaper('p1')
    st().setScreeningDecision('Include')
    expect(st().project!.papers[0].annotations.Decision[0].value).toBeNull()
    expect(st().dirty).toBe(false)
  })

  it('writes into Reviewer 2\'s own tree', () => {
    st().loadFromText(screeningProject({ reviewers: 2 }), null, 'test.json')
    st().selectPaper('p1')
    st().selectReviewer('2')
    st().setScreeningDecision('Exclude')
    expect(st().project!.papers[0].reviews['2'].Decision[0].value).toBe('Exclude')
    expect(st().project!.papers[0].annotations.Decision[0].value).toBeNull()
  })

  it('writes into the Consolidation seat\'s annotations tree', () => {
    st().loadFromText(screeningProject({ reviewers: 2 }), null, 'test.json')
    st().selectPaper('p1')
    st().selectReviewer('consolidation')
    st().setScreeningDecision('Include')
    expect(st().project!.papers[0].annotations.Decision[0].value).toBe('Include')
  })

  it('is one undo step', () => {
    st().loadFromText(screeningProject(), null, 'test.json')
    st().selectPaper('p1')
    st().setScreeningDecision('Include')
    expect(st().past).toHaveLength(1)
    st().undo()
    expect(st().project!.papers[0].annotations.Decision[0].value).toBeNull()
  })

  it('clears the reason in the same undo step when changing away from Exclude', () => {
    // A single paper, so auto-advance (undecided -> decided) never fires and
    // cannot move the selection out from under the second decision below.
    st().loadFromText(
      screeningProject({ papers: [{ id: 'only', title: 'Only', authors: [], pdf: '', annotations: {} }] }),
      null,
      'test.json',
    )
    st().selectPaper('only')
    st().setScreeningDecision('Exclude')
    st().setFieldValue([], 'Reason', 0, 'Duplicate')
    expect(st().past).toHaveLength(2)

    st().setScreeningDecision('Include')
    const paper = st().project!.papers[0]
    expect(paper.annotations.Decision[0].value).toBe('Include')
    expect(paper.annotations.Reason[0].value).toBeNull()

    st().undo()
    const after = st().project!.papers[0]
    expect(after.annotations.Decision[0].value).toBe('Exclude')
    expect(after.annotations.Reason[0].value).toBe('Duplicate')
  })

  it('writes decision and reason together in one undo step (the 1-9 shortcut path)', () => {
    st().loadFromText(screeningProject(), null, 'test.json')
    st().selectPaper('p1')
    st().setScreeningDecision('Exclude', 'Duplicate')
    const paper = st().project!.papers[0]
    expect(paper.annotations.Decision[0].value).toBe('Exclude')
    expect(paper.annotations.Reason[0].value).toBe('Duplicate')
    expect(st().past).toHaveLength(1)
    st().undo()
    expect(st().project!.papers[0].annotations.Decision[0].value).toBeNull()
  })

  it('advances to the next undecided paper on undecided -> decided', () => {
    st().loadFromText(screeningProject(), null, 'test.json')
    st().selectPaper('p1')
    st().setScreeningDecision('Include')
    expect(st().currentPaperId).toBe('p2')
  })

  it('does not advance when re-deciding an already-decided paper', () => {
    st().loadFromText(screeningProject(), null, 'test.json')
    st().selectPaper('p1')
    st().setScreeningDecision('Include')
    st().selectPaper('p1')
    st().setScreeningDecision('Exclude', 'Duplicate')
    expect(st().currentPaperId).toBe('p1')
  })

  it('does not advance when un-deciding (decision -> null)', () => {
    st().loadFromText(screeningProject(), null, 'test.json')
    st().selectPaper('p1')
    st().setScreeningDecision('Include')
    st().selectPaper('p1')
    st().setScreeningDecision(null)
    expect(st().currentPaperId).toBe('p1')
  })

  it('stops at the last paper rather than wrapping', () => {
    st().loadFromText(screeningProject({ papers: [{ id: 'only', title: 'Only', authors: [], pdf: '', annotations: {} }] }), null, 'test.json')
    st().selectPaper('only')
    st().setScreeningDecision('Include')
    expect(st().currentPaperId).toBe('only')
  })
})

describe('setScreeningReason', () => {
  it('is a no-op unless the seat\'s decision is Exclude', () => {
    st().loadFromText(screeningProject(), null, 'test.json')
    st().selectPaper('p1')
    st().setScreeningReason('Duplicate')
    expect(st().project!.papers[0].annotations.Reason[0].value).toBeNull()

    st().setScreeningDecision('Include')
    st().setScreeningReason('Duplicate')
    expect(st().project!.papers[0].annotations.Reason[0].value).toBeNull()
  })

  it('writes the reason once excluded', () => {
    st().loadFromText(
      screeningProject({ papers: [{ id: 'only', title: 'Only', authors: [], pdf: '', annotations: {} }] }),
      null,
      'test.json',
    )
    st().selectPaper('only')
    st().setScreeningDecision('Exclude')
    st().setScreeningReason('Wrong topic')
    expect(st().project!.papers[0].annotations.Reason[0].value).toBe('Wrong topic')
  })
})

describe('applyAiSuggestions on a screening project', () => {
  it('refuses and fills nothing', () => {
    st().loadFromText(screeningProject(), null, 'test.json')
    st().selectPaper('p1')
    const result = st().applyAiSuggestions(
      [{ path: 'Decision', value: 'Include', evidence: 'x', confidence: null }],
      { provider: 'openai', model: 'gpt' },
      { paperId: st().currentPaperId!, reviewer: st().currentReviewer },
    )
    expect(result.filled).toBe(0)
    expect(st().project!.papers[0].annotations.Decision[0].value).toBeNull()
  })
})

describe('adoptAllUnanimousScreening', () => {
  it('returns 0 for a single-reviewer project', () => {
    st().loadFromText(screeningProject(), null, 'test.json')
    expect(st().adoptAllUnanimousScreening()).toBe(0)
  })

  it('returns 0 for a non-screening project', () => {
    st().loadFromText(
      JSON.stringify({
        version: 1,
        config: { schema: [{ name: 'X', type: 'string' }], reviewers: 2 },
        papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
      }),
      null,
      'test.json',
    )
    expect(st().adoptAllUnanimousScreening()).toBe(0)
  })

  it('fills every unanimous paper in one undo step and returns the paper count', () => {
    st().loadFromText(
      screeningProject({
        reviewers: 2,
        papers: [
          { id: 'p1', title: 'One', authors: [], pdf: '', annotations: {} },
          { id: 'p2', title: 'Two', authors: [], pdf: '', annotations: {} },
        ],
      }),
      null,
      'test.json',
    )
    st().selectReviewer('1')
    st().selectPaper('p1')
    st().setScreeningDecision('Include')
    st().selectPaper('p2')
    st().setScreeningDecision('Exclude', 'Duplicate')
    st().selectReviewer('2')
    st().selectPaper('p1')
    st().setScreeningDecision('Include')
    st().selectPaper('p2')
    st().setScreeningDecision('Exclude', 'Duplicate')

    const pastBefore = st().past.length
    // p1: only Decision is unanimous (Reason is unanswered on both — not a
    // fill). p2: both Decision and Reason are unanimous. Two *papers* get
    // something filled, even though three individual fields do.
    const filled = st().adoptAllUnanimousScreening()
    expect(filled).toBe(2)
    expect(st().project!.papers[0].annotations.Decision[0].value).toBe('Include')
    expect(st().project!.papers[1].annotations.Decision[0].value).toBe('Exclude')
    expect(st().project!.papers[1].annotations.Reason[0].value).toBe('Duplicate')
    // One undo step for the whole run.
    expect(st().past.length).toBe(pastBefore + 1)
  })

  it('skips papers where reviewers disagreed', () => {
    st().loadFromText(screeningProject({ reviewers: 2 }), null, 'test.json')
    st().selectReviewer('1')
    st().selectPaper('p1')
    st().setScreeningDecision('Include')
    st().selectReviewer('2')
    st().selectPaper('p1')
    st().setScreeningDecision('Exclude', 'Duplicate')

    expect(st().adoptAllUnanimousScreening()).toBe(0)
    expect(st().project!.papers[0].annotations.Decision[0].value).toBeNull()
  })

  it('skips a paper Consolidation already answered', () => {
    st().loadFromText(screeningProject({ reviewers: 2 }), null, 'test.json')
    st().selectReviewer('1')
    st().selectPaper('p1')
    st().setScreeningDecision('Include')
    st().selectReviewer('2')
    st().selectPaper('p1')
    st().setScreeningDecision('Include')
    st().selectReviewer('consolidation')
    st().selectPaper('p1')
    st().setScreeningDecision('Exclude', 'Duplicate')

    expect(st().adoptAllUnanimousScreening()).toBe(0)
    expect(st().project!.papers[0].annotations.Decision[0].value).toBe('Exclude')
  })
})
