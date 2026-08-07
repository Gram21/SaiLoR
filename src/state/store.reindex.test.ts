import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { Suggestion } from '../llm/types'

/**
 * Removing a repeatable instance shifts every canonical-path-keyed structure
 * that names a later sibling — mark `linkedFields`, `aiMarks`, `paper.equal`,
 * `deferredConsolidations` — so a link attached to entry #3 follows that
 * entry into its new slot instead of sticking to whichever entry now sits at
 * index 2. See `shiftCanonicalPath` and `removeInstance` in `./store`.
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

const { useStore, aiMarkKey } = await import('./store')

const schema = [
  { name: 'Finding', type: 'string' as const, min: 1, max: null },
  { name: 'Findings', min: 1, max: null, children: [{ name: 'Claim', type: 'string' as const }] },
  { name: 'Population / Setting', type: 'string' as const, min: 1, max: null },
]

function projectText(reviewers = 1): string {
  return JSON.stringify({
    version: 1,
    config: { schema, ...(reviewers > 1 ? { reviewers } : {}) },
    papers: [{ id: 'p1', title: 'One', authors: [], pdf: 'p1.pdf', annotations: {} }],
  })
}

const st = () => useStore.getState()
const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 }

/** `def` for a top-level repeatable field, by name — for `addInstance`. */
const defOf = (name: string) => st().project!.schema.find((d) => d.name === name)!

describe('removeInstance — reindexes canonical-path-keyed state', () => {
  beforeEach(() => {
    st().loadFromText(projectText(1), null, 'test.json')
    st().selectPaper('p1')
  })

  it('link on Finding #2 (index 1), removing index 0, collapses to unindexed', () => {
    st().addInstance([], defOf('Finding')) // Finding[1] now exists
    const id = st().addHighlight(1, [rect])!
    st().linkMarkToField(id, [], 'Finding', 1) // links Finding #2 (index 1)
    st().removeInstance([], 'Finding', 0)

    const mark = st().currentPdfMarks()[0]
    expect(mark.linkedFields).toEqual([{ path: 'Finding', label: 'Finding' }])
  })

  it('link on Finding #3, removing #1, shifts the path and re-derives the label', () => {
    st().addInstance([], defOf('Finding'))
    st().addInstance([], defOf('Finding')) // Finding[0..2] now exist
    const id = st().addHighlight(1, [rect])!
    st().linkMarkToField(id, [], 'Finding', 2) // Finding #3
    st().removeInstance([], 'Finding', 0) // remove #1

    const mark = st().currentPdfMarks()[0]
    expect(mark.linkedFields).toEqual([{ path: 'Finding[1]', label: 'Finding #2' }])
  })

  it('link on the removed entry itself is dropped, deleting linkedFields once empty', () => {
    st().addInstance([], defOf('Finding'))
    const id = st().addHighlight(1, [rect])!
    st().linkMarkToField(id, [], 'Finding', 1) // Finding #2
    st().removeInstance([], 'Finding', 1) // remove #2 — the same entry

    const mark = st().currentPdfMarks()[0]
    expect(mark.linkedFields).toBeUndefined()
  })

  it('nested: link Findings[2]/Claim, removing Findings[1] shifts it, removing Findings[2] drops it', () => {
    st().addInstance([], defOf('Findings'))
    st().addInstance([], defOf('Findings')) // Findings[0..2] exist
    const id = st().addHighlight(1, [rect])!
    st().linkMarkToField(id, [{ name: 'Findings', index: 2 }], 'Claim', 0)
    expect(st().currentPdfMarks()[0].linkedFields).toEqual([
      { path: 'Findings[2]/Claim', label: 'Findings #3 › Claim' },
    ])

    st().removeInstance([], 'Findings', 1) // remove Findings #2 -> old #3 becomes #2
    expect(st().currentPdfMarks()[0].linkedFields).toEqual([
      { path: 'Findings[1]/Claim', label: 'Findings #2 › Claim' },
    ])

    st().removeInstance([], 'Findings', 1) // now remove the entry actually linked
    expect(st().currentPdfMarks()[0].linkedFields).toBeUndefined()
  })

  it('removing the LAST entry leaves every path and updatedAt untouched', () => {
    st().addInstance([], defOf('Finding')) // Finding[0..1]
    const id = st().addHighlight(1, [rect])!
    st().linkMarkToField(id, [], 'Finding', 0)
    const before = st().currentPdfMarks()[0].updatedAt

    st().removeInstance([], 'Finding', 1) // remove the last one, index 1

    const mark = st().currentPdfMarks()[0]
    expect(mark.linkedFields).toEqual([{ path: 'Finding', label: 'Finding' }])
    expect(mark.updatedAt).toBe(before)
  })

  it('aiMarks: a mark on Finding[2] follows the entry down to index 1', () => {
    st().addInstance([], defOf('Finding'))
    st().addInstance([], defOf('Finding')) // Finding[0..2]
    const sug = (path: string): Suggestion => ({
      path,
      value: 'x',
      evidence: 'quoted',
      confidence: 0.9,
    })
    st().applyAiSuggestions([sug('Finding[2]')], { provider: 'openai', model: 'gpt-5.5' }, {
      paperId: 'p1',
      reviewer: null,
    })
    expect(st().aiMarks[aiMarkKey('p1', 'Finding[2]')]).toBe(true)

    st().removeInstance([], 'Finding', 0)

    expect(st().aiMarks[aiMarkKey('p1', 'Finding[2]')]).toBeUndefined()
    expect(st().aiMarks[aiMarkKey('p1', 'Finding[1]')]).toBe(true)
  })

  it('one escaped-name case round-trips through parsePath/formatPath', () => {
    st().addInstance([], defOf('Population / Setting'))
    st().addInstance([], defOf('Population / Setting')) // instances 0..2
    const id = st().addHighlight(1, [rect])!
    st().linkMarkToField(id, [], 'Population / Setting', 2)
    expect(st().currentPdfMarks()[0].linkedFields![0].path).toBe('Population \\/ Setting[2]')

    st().removeInstance([], 'Population / Setting', 0)

    expect(st().currentPdfMarks()[0].linkedFields).toEqual([
      { path: 'Population \\/ Setting[1]', label: 'Population / Setting #2' },
    ])
  })
})

describe('removeInstance — multi-reviewer scoping', () => {
  beforeEach(() => {
    st().loadFromText(projectText(2), null, 'test.json')
    st().selectPaper('p1')
  })

  it("shifts only reviewer 2's own marks, leaving Consolidation's paper.equal/deferredConsolidations untouched", () => {
    st().selectReviewer('2')
    st().addInstance([], defOf('Finding'))
    st().addInstance([], defOf('Finding'))
    const id = st().addHighlight(1, [rect])!
    st().linkMarkToField(id, [], 'Finding', 2)

    st().selectReviewer('consolidation')
    st().addInstance([], defOf('Finding'))
    st().addInstance([], defOf('Finding'))
    const consolidationId = st().addHighlight(1, [rect])!
    st().linkMarkToField(consolidationId, [], 'Finding', 2)
    // Resolving a value settles the field but no longer marks it "the
    // reviewers agreed" (see store.reviewers.test.ts) — `paper.equal` stays
    // empty here, so this test now exercises only `deferredConsolidations`.
    st().resolveConsolidationValue([], 'Finding', 2, 'x')
    st().deferConsolidationValue([], 'Finding', 2)

    st().selectReviewer('2')
    st().removeInstance([], 'Finding', 0) // shifts reviewer 2's own tree/marks only

    expect(st().currentPdfMarks()[0].linkedFields).toEqual([{ path: 'Finding[1]', label: 'Finding #2' }])

    st().selectReviewer('consolidation')
    expect(st().currentPdfMarks()[0].linkedFields).toEqual([{ path: 'Finding[2]', label: 'Finding #3' }])
    expect(st().project!.papers[0].equal).toEqual([])
    expect(Object.keys(st().deferredConsolidations)).toEqual(['p1::Finding[2]'])
  })
})
