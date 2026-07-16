import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'

/**
 * `toggleFieldEquality`: the store side of "these answers mean the same
 * thing". Unlike `selectReviewer`, this is a real data change — it lands in
 * `Paper.equal`, which is written to the saved file — so it takes an undo
 * step and sets `dirty`, same as `setFieldValue`.
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
  {
    name: 'Findings',
    min: 1,
    max: null,
    children: [{ name: 'Claim', type: 'string' as const }],
  },
]

function projectText(reviewers = 2): string {
  return JSON.stringify({
    version: 1,
    config: { schema, reviewers },
    papers: [
      { id: 'p1', title: 'One', authors: [], pdf: 'p1.pdf', annotations: {} },
      { id: 'p2', title: 'Two', authors: [], pdf: 'p2.pdf', annotations: {} },
    ],
  })
}

const st = () => useStore.getState()
const equalOf = (paperId: string) => st().project!.papers.find((p) => p.id === paperId)!.equal

beforeEach(() => {
  st().loadFromText(projectText(), null, 'test.json')
  st().selectPaper('p1')
})

describe('toggleFieldEquality', () => {
  it('marks a field equal on first toggle', () => {
    st().toggleFieldEquality('p1', 'Study Type')
    expect(equalOf('p1')).toEqual(['Study Type'])
  })

  it('unmarks it on a second toggle', () => {
    st().toggleFieldEquality('p1', 'Study Type')
    st().toggleFieldEquality('p1', 'Study Type')
    expect(equalOf('p1')).toEqual([])
  })

  it('tracks several fields independently', () => {
    st().toggleFieldEquality('p1', 'Study Type')
    st().toggleFieldEquality('p1', 'Findings/Claim')
    expect(equalOf('p1').slice().sort()).toEqual(['Findings/Claim', 'Study Type'])

    st().toggleFieldEquality('p1', 'Study Type')
    expect(equalOf('p1')).toEqual(['Findings/Claim'])
  })

  it('sets dirty, because it changes saved data', () => {
    expect(st().dirty).toBe(false)
    st().toggleFieldEquality('p1', 'Study Type')
    expect(st().dirty).toBe(true)
  })

  it('is one undo step, and undo restores the previous mark state', () => {
    st().toggleFieldEquality('p1', 'Study Type')
    expect(st().past).toHaveLength(1)
    st().undo()
    expect(equalOf('p1')).toEqual([])
  })

  it('a second toggle is its own undo step', () => {
    st().toggleFieldEquality('p1', 'Study Type')
    st().toggleFieldEquality('p1', 'Findings/Claim')
    expect(st().past).toHaveLength(2)
    st().undo()
    expect(equalOf('p1')).toEqual(['Study Type'])
    st().undo()
    expect(equalOf('p1')).toEqual([])
  })

  it('does nothing for an unknown paper — no crash, no undo step, not dirty', () => {
    expect(() => st().toggleFieldEquality('nope', 'Study Type')).not.toThrow()
    expect(st().past).toHaveLength(0)
    expect(st().dirty).toBe(false)
  })

  it('does not disturb the other paper\'s marks', () => {
    st().toggleFieldEquality('p1', 'Study Type')
    expect(equalOf('p2')).toEqual([])
  })

  it('does not disturb annotations, aiMarks, or the current paper/reviewer selection', () => {
    st().selectReviewer('1')
    const before = st().project!.papers[0].annotations
    const marksBefore = st().aiMarks

    st().toggleFieldEquality('p1', 'Study Type')

    expect(st().project!.papers[0].annotations).toBe(before)
    expect(st().aiMarks).toBe(marksBefore)
    expect(st().currentPaperId).toBe('p1')
    expect(st().currentReviewer).toBe('1')
  })

  it('resets the field-edit coalescing key, so a later keystroke does not merge into this undo entry', () => {
    st().selectReviewer('1')
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    st().toggleFieldEquality('p1', 'Study Type')
    const depth = st().past.length
    st().setFieldValue([], 'Study Type', 0, 'RCTX')
    expect(st().past.length).toBe(depth + 1)
  })

  it('works on a single-reviewer project too — the mark is not gated on reviewers > 1', () => {
    st().loadFromText(
      JSON.stringify({
        version: 1,
        config: { schema },
        papers: [{ id: 'p1', title: 'One', authors: [], pdf: 'p1.pdf', annotations: {} }],
      }),
      null,
      'single.json',
    )
    st().selectPaper('p1')
    st().toggleFieldEquality('p1', 'Study Type')
    expect(equalOf('p1')).toEqual(['Study Type'])
  })
})
