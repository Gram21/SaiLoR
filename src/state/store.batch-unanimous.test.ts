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
 * `adoptAllUnanimousAnnotations`: the project-wide version of opening every
 * paper as Consolidation just to trigger the per-paper auto-fill
 * (`useConsolidationAlignment`). What matters here is the thing that makes the
 * fixed-index read in `adoptUnanimousValues` safe at all: every paper must be
 * *aligned* before it is adopted, and a paper the consolidator has already
 * partly answered must be left alone rather than realigned underneath them.
 * See `store.align.test.ts` for the two building blocks this drives.
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

const st = () => useStore.getState()

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const swappedSchema = [
  { name: 'Study Type', type: 'string' as const },
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

const findingCE = (claim: string) => ({ children: { Claim: [{ value: claim }] } })

/** Two reviewers who recorded the same three findings in opposite orders, plus
 *  a unanimous scalar (typed differently) on every paper. */
function swappedProject(n: number): string {
  const papers = Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    title: `Paper ${i + 1}`,
    authors: [],
    pdf: 'a.pdf',
    annotations: {},
    reviews: {
      '1': {
        'Study Type': [{ value: 'RCT' }],
        Findings: [findingCE('Alpha'), findingCE('Beta'), findingCE('Gamma')],
      },
      '2': {
        'Study Type': [{ value: '  rct ' }],
        Findings: [findingCE('Gamma'), findingCE('Alpha'), findingCE('Beta')],
      },
    },
  }))
  return JSON.stringify({
    version: 1,
    config: { schema: swappedSchema, reviewers: 2 },
    papers,
  })
}

const trapSchema = [
  {
    name: 'Findings',
    min: 2,
    max: null,
    children: [
      { name: 'Claim', type: 'string' as const },
      { name: 'Method', type: 'string' as const },
    ],
  },
]

const findingCM = (claim: string, method: string) => ({
  children: { Claim: [{ value: claim }], Method: [{ value: method }] },
})

/**
 * The fixture that matters: two reviewers who genuinely agree on *what* the
 * findings are but list them in different orders, and genuinely *disagree* on
 * one reviewer-recorded detail of each. `min: 2` grows the consolidated tree
 * to two entries the moment the project loads (see `normalizeTree`), which is
 * what lets a fixed-index read reach index 1 without any alignment having run
 * at all — the exact shape the correctness trap needs to be reachable.
 *
 * Read across at a fixed index (no alignment): index 0 is R1's "speed/RCT" vs
 * R2's "cost/RCT" — Claims differ, but Method agrees ("RCT"="RCT") purely by
 * coincidence of position, and would be adopted as if the reviewers had agreed
 * on a method. They did not: R1 said RCT of "speed", R2 said RCT of "cost".
 * Aligned first, the entries pair by *content* (speed with speed, cost with
 * cost), at which point Claim genuinely agrees and Method genuinely does not.
 */
function trapProject(): string {
  return JSON.stringify({
    version: 1,
    config: { schema: trapSchema, reviewers: 2 },
    papers: [
      {
        id: 'p1',
        title: 'Trap',
        authors: [],
        pdf: 'a.pdf',
        annotations: {},
        reviews: {
          '1': { Findings: [findingCM('speed', 'RCT'), findingCM('cost', 'survey')] },
          '2': { Findings: [findingCM('cost', 'RCT'), findingCM('speed', 'survey')] },
        },
      },
    ],
  })
}

function screeningProject(): string {
  return JSON.stringify({
    version: 1,
    config: { screening: { reasons: ['Duplicate'] }, reviewers: 2 },
    papers: [{ id: 'p1', title: 'One', authors: [], pdf: '', annotations: {} }],
  })
}

const claimsOf = (paperId: string, reviewer: string) =>
  (st().project!.papers.find((p) => p.id === paperId)!.reviews[reviewer]['Findings'] ?? []).map(
    (f) => f.children?.['Claim']?.[0]?.value ?? null,
  )

beforeEach(() => {
  localStorage.clear()
})

describe('adoptAllUnanimousAnnotations', () => {
  it('aligns then adopts across every paper', async () => {
    st().loadFromText(swappedProject(2), null, 'test.json')
    st().selectReviewer('consolidation')

    await st().adoptAllUnanimousAnnotations()

    for (const paperId of ['p1', 'p2']) {
      expect(claimsOf(paperId, '1')).toEqual(['Alpha', 'Beta', 'Gamma'])
      expect(claimsOf(paperId, '2')).toEqual(['Alpha', 'Beta', 'Gamma'])
      const paper = st().project!.papers.find((p) => p.id === paperId)!
      expect(paper.annotations['Findings']).toHaveLength(3)
      const claims = paper.annotations['Findings'].map((f) => f.children?.['Claim']?.[0]?.value)
      expect(claims).toEqual(['Alpha', 'Beta', 'Gamma'])
      expect(paper.annotations['Study Type'][0].value).toBe('RCT')
    }
  })

  it('the trap fixture: must not fabricate agreement at a fixed index', async () => {
    st().loadFromText(trapProject(), null, 'test.json')
    st().selectReviewer('consolidation')

    await st().adoptAllUnanimousAnnotations()

    const consolidated = st().project!.papers[0].annotations['Findings']
    const claims = consolidated.map((f) => f.children?.['Claim']?.[0]?.value)
    const methods = consolidated.map((f) => f.children?.['Method']?.[0]?.value)
    // Genuine agreement, once aligned by content.
    expect(claims).toEqual(['speed', 'cost'])
    // The reviewers never agreed on a method for either finding — RCT/survey
    // landing at the same index was an accident of the unaligned order, and
    // must not be read as consensus.
    expect(methods).toEqual([null, null])
  })

  it('fixed-index adoption without aligning first is the bug the batch exists to avoid', () => {
    // Pins the hazard directly: calling `adoptUnanimousValues` on the trap
    // fixture with no alignment step *does* write Method, proving the ordering
    // in `adoptAllUnanimousAnnotations` (align, then adopt) is load-bearing,
    // not incidental.
    st().loadFromText(trapProject(), null, 'test.json')
    st().selectReviewer('consolidation')

    st().adoptUnanimousValues('p1', false)

    const consolidated = st().project!.papers[0].annotations['Findings']
    const methods = consolidated.map((f) => f.children?.['Method']?.[0]?.value)
    expect(methods).toEqual(['RCT', 'survey'])
  })

  it('is one undo press for the whole batch', async () => {
    st().loadFromText(swappedProject(2), null, 'test.json')
    st().selectReviewer('consolidation')

    await st().adoptAllUnanimousAnnotations()

    expect(st().past).toHaveLength(1)
    st().undo()
    expect(claimsOf('p1', '2')).toEqual(['Gamma', 'Alpha', 'Beta'])
    expect(claimsOf('p2', '2')).toEqual(['Gamma', 'Alpha', 'Beta'])
    expect(st().project!.papers[0].annotations['Study Type'][0].value).toBeNull()
    expect(st().project!.papers[1].annotations['Study Type'][0].value).toBeNull()
  })

  it('takes no undo step and is not dirty when there is nothing to do', async () => {
    st().loadFromText(
      JSON.stringify({
        version: 1,
        config: { schema: swappedSchema, reviewers: 2 },
        papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
      }),
      null,
      'test.json',
    )
    st().selectReviewer('consolidation')

    await st().adoptAllUnanimousAnnotations()

    expect(st().past).toHaveLength(0)
    expect(st().dirty).toBe(false)
  })

  it('skips a paper the consolidator has already answered under a matched group', async () => {
    st().loadFromText(trapProject(), null, 'test.json')
    st().selectReviewer('consolidation')
    // The consolidator commits an answer under Findings before the batch runs.
    st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'my own call')

    await st().adoptAllUnanimousAnnotations()

    expect(st().unanimousRun?.skipped).toBe(1)
    expect(st().unanimousRun?.filled).toBe(0)
    const consolidated = st().project!.papers[0].annotations['Findings']
    // Untouched beyond the consolidator's own edit — no Method fabricated.
    expect(consolidated[0].children?.['Claim']?.[0]?.value).toBe('my own call')
    expect(consolidated[0].children?.['Method']?.[0]?.value).toBeNull()
    expect(consolidated[1]?.children?.['Method']?.[0]?.value ?? null).toBeNull()
  })

  it('the guard is per paper: a blocked paper does not stop the rest', async () => {
    st().loadFromText(swappedProject(2), null, 'test.json')
    st().selectReviewer('consolidation')
    st().selectPaper('p1')
    st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'my own call')

    await st().adoptAllUnanimousAnnotations()

    expect(st().unanimousRun?.skipped).toBe(1)
    expect(st().unanimousRun?.filled).toBe(1)
    // p2 was untouched by the consolidator, so it aligns and adopts normally.
    expect(claimsOf('p2', '1')).toEqual(['Alpha', 'Beta', 'Gamma'])
    const p2 = st().project!.papers.find((p) => p.id === 'p2')!
    expect(p2.annotations['Study Type'][0].value).toBe('RCT')
  })

  it('adopts non-repeatable fields too', async () => {
    st().loadFromText(swappedProject(1), null, 'test.json')
    st().selectReviewer('consolidation')

    await st().adoptAllUnanimousAnnotations()

    // First reviewer's wording, per `adoptUnanimousValues`.
    expect(st().project!.papers[0].annotations['Study Type'][0].value).toBe('RCT')
  })

  it('marks adopted fields under the Consolidation seat, like a per-paper run does', async () => {
    st().loadFromText(swappedProject(1), null, 'test.json')
    st().selectReviewer('consolidation')

    await st().adoptAllUnanimousAnnotations()

    const keys = Object.keys(st().aiMarks)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((k) => k.startsWith('p1::consolidation::'))).toBe(true)
  })

  it('reports progress and finishes not running', async () => {
    st().loadFromText(swappedProject(3), null, 'test.json')
    st().selectReviewer('consolidation')

    const run = st().adoptAllUnanimousAnnotations()
    expect(st().unanimousRun?.total).toBe(3)
    await run

    expect(st().unanimousRun?.done).toBe(3)
    expect(st().unanimousRun?.running).toBe(false)
  })

  it('a second concurrent call is a no-op', async () => {
    st().loadFromText(swappedProject(2), null, 'test.json')
    st().selectReviewer('consolidation')

    const first = st().adoptAllUnanimousAnnotations()
    const second = st().adoptAllUnanimousAnnotations()
    await Promise.all([first, second])

    expect(st().past).toHaveLength(1)
  })

  it('is a no-op for a screening project (that keeps its own button)', async () => {
    st().loadFromText(screeningProject(), null, 'test.json')
    st().selectReviewer('consolidation')

    await st().adoptAllUnanimousAnnotations()

    expect(st().unanimousRun).toBeNull()
    expect(st().dirty).toBe(false)
  })

  it('is a no-op for a single-reviewer project', async () => {
    st().loadFromText(
      JSON.stringify({
        version: 1,
        config: { schema: swappedSchema },
        papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
      }),
      null,
      'test.json',
    )

    await st().adoptAllUnanimousAnnotations()

    expect(st().unanimousRun).toBeNull()
    expect(st().dirty).toBe(false)
  })

  it('stops when the project closes mid-run', async () => {
    st().loadFromText(swappedProject(5), null, 'test.json')
    st().selectReviewer('consolidation')

    const run = st().adoptAllUnanimousAnnotations()
    // Give the first paper's yield a chance to happen, then close.
    await Promise.resolve()
    st().closeProject()

    await run
    // closeProject already cleared the project; nothing left to assert on it
    // beyond the run having returned without throwing.
    expect(st().project).toBeNull()
  })
})

describe('dismissUnanimousRun', () => {
  it('clears the run summary', async () => {
    st().loadFromText(swappedProject(1), null, 'test.json')
    st().selectReviewer('consolidation')
    await st().adoptAllUnanimousAnnotations()
    expect(st().unanimousRun).not.toBeNull()

    st().dismissUnanimousRun()
    expect(st().unanimousRun).toBeNull()
  })
})

describe('adoptAllUnanimousScreening still works (regression)', () => {
  it('fills unanimous screening decisions in one undo step', () => {
    st().loadFromText(
      JSON.stringify({
        version: 1,
        config: { screening: { reasons: ['Duplicate'] }, reviewers: 2 },
        papers: [{ id: 'p1', title: 'One', authors: [], pdf: '', annotations: {} }],
      }),
      null,
      'test.json',
    )
    st().selectReviewer('1')
    st().selectPaper('p1')
    st().setScreeningDecision('Include')
    st().selectReviewer('2')
    st().setScreeningDecision('Include')
    st().selectReviewer('consolidation')
    const pastBefore = st().past.length

    const filled = st().adoptAllUnanimousScreening()
    expect(filled).toBe(1)
    expect(st().project!.papers[0].annotations.Decision[0].value).toBe('Include')
    expect(st().past.length).toBe(pastBefore + 1)
  })
})
