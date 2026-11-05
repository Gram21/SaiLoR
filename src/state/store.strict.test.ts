import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SaveHandle } from '../platform/adapter'

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

let written: string[] = []
const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  saveProject: async (text: string, handle: SaveHandle) => {
    written.push(text)
    return handle
  },
  rebasePdfPaths: async (pdfPaths: string[]) => pdfPaths,
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore, activePerson, consolidationGateMissing, finishReady, STRICT_MANAGER } = await import('./store')

const HANDLE = { kind: 'electron' as const, path: '/reviews/strict.json' }
const paper = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, authors: [], pdf: `${id}.pdf`, ...extra })

function projectText(papers = [paper('a'), paper('b'), paper('c')]) {
  return JSON.stringify({
    version: 1,
    config: {
      schema: [{ name: 'Relevant', type: 'boolean' }],
      reviewers: 2,
      strict: true,
      persons: [
        { id: 'ann', name: 'Ann' },
        { id: 'bob', name: 'Bob' },
      ],
      assignments: {
        a: [{ person: 'ann', seat: 1 }, { person: 'bob', seat: 2 }],
        b: [{ person: 'bob', seat: 1 }],
        c: [{ person: 'ann', seat: 2 }],
      },
    },
    papers,
  })
}

const st = () => useStore.getState()

beforeEach(() => {
  localStorage.clear()
  written = []
  st().setReadOnly(false)
  st().loadFromText(projectText(), HANDLE, 'strict.json')
})

describe('strict mode person', () => {
  it('starts with no person, then works on the assigned papers with a fixed seat', () => {
    expect(st().strictPerson).toBeNull()
    st().choosePerson('ann')
    expect(activePerson(st())).toBe('ann')
    expect(st().currentPaperId).toBe('a')
    expect(st().currentReviewer).toBe('1')

    st().selectPaper('b')
    expect(st().currentPaperId).toBe('a')
    st().selectPaper('c')
    expect(st().currentPaperId).toBe('c')
    expect(st().currentReviewer).toBe('2')

    st().selectReviewer('consolidation')
    expect(st().currentReviewer).toBe('2')
  })

  it('remembers the person per project and forgets an unknown one', () => {
    st().choosePerson('bob')
    st().loadFromText(projectText(), HANDLE, 'strict.json')
    expect(st().strictPerson).toBe('bob')
    expect(st().currentPaperId).toBe('a')
    expect(st().currentReviewer).toBe('2')

    localStorage.setItem('slr.strictPerson./reviews/strict.json', 'eve')
    st().loadFromText(projectText(), HANDLE, 'strict.json')
    expect(st().strictPerson).toBeNull()
  })

  it('refuses to change the person with unsaved changes', () => {
    st().choosePerson('ann')
    st().setFieldValue([], 'Relevant', 0, true)
    st().switchPerson()
    expect(st().strictPerson).toBe('ann')
    st().choosePerson(STRICT_MANAGER)
    expect(st().strictPerson).toBe('ann')
  })

  it('lets the Manager choose any seat and paper', () => {
    st().choosePerson(STRICT_MANAGER)
    expect(activePerson(st())).toBeNull()
    st().selectPaper('b')
    st().selectReviewer('consolidation')
    expect(st().currentPaperId).toBe('b')
    expect(st().currentReviewer).toBe('consolidation')
  })

  it('finishes every assigned paper and saves, and keeps a saved flag', async () => {
    st().choosePerson('ann')
    expect(await st().finishPersonWork()).toBe(true)
    const papers = st().project!.papers
    expect(papers.find((p) => p.id === 'a')!.reviewsFinished).toEqual({ '1': true })
    expect(papers.find((p) => p.id === 'b')!.reviewsFinished).toEqual({})
    expect(papers.find((p) => p.id === 'c')!.reviewsFinished).toEqual({ '2': true })
    expect(st().dirty).toBe(false)
    expect(written).toHaveLength(1)

    st().setAnnotationFinished(false)
    expect(st().project!.papers.find((p) => p.id === 'a')!.reviewsFinished).toEqual({ '1': true })
  })

  it('lets a person untick a flag that is not saved yet', () => {
    st().choosePerson('ann')
    st().setAnnotationFinished(true)
    st().setAnnotationFinished(false)
    expect(st().project!.papers[0].reviewsFinished).toEqual({})
  })
})

describe('strict mode consolidation gate', () => {
  it('lists the persons who have not finished, until the Manager overrides', () => {
    st().loadFromText(projectText([paper('a', { reviewsFinished: { '1': true } }), paper('b'), paper('c')]), HANDLE, 'strict.json')
    st().choosePerson(STRICT_MANAGER)
    st().selectPaper('a')
    st().selectReviewer('consolidation')
    expect(consolidationGateMissing(st()).map((p) => p.name)).toEqual(['Bob'])

    st().overrideConsolidationGate('a')
    expect(consolidationGateMissing(st())).toEqual([])

    st().loadFromText(projectText([paper('a', { reviewsFinished: { '1': true } }), paper('b'), paper('c')]), HANDLE, 'strict.json')
    st().selectPaper('a')
    st().selectReviewer('consolidation')
    expect(consolidationGateMissing(st()).map((p) => p.name)).toEqual(['Bob'])
  })

  it('opens when every assigned person has finished', () => {
    st().loadFromText(projectText([paper('a', { reviewsFinished: { '1': true, '2': true } }), paper('b'), paper('c')]), HANDLE, 'strict.json')
    st().choosePerson(STRICT_MANAGER)
    st().selectPaper('a')
    st().selectReviewer('consolidation')
    expect(consolidationGateMissing(st())).toEqual([])
  })

  it('refuses the override for a person', () => {
    st().choosePerson('ann')
    st().overrideConsolidationGate('a')
    expect(st().consolidationOverrides).toEqual({})
  })
})

// [utest->req~con-540~1]
// [utest->req~con-560~1]
// [utest->req~con-570~1]
describe('edit lock', () => {
  const paperA = () => st().project!.papers.find((p) => p.id === 'a')!
  const answerAll = () => {
    st().selectPaper('a')
    st().setFieldValue([], 'Relevant', 0, true)
    st().selectPaper('c')
    st().setFieldValue([], 'Relevant', 0, true)
    st().selectPaper('a')
  }
  const lockAsAnn = async () => {
    st().choosePerson('ann')
    answerAll()
    expect(finishReady(st().project, 'ann')).toBe(true)
    expect(await st().finishPersonWork()).toBe(true)
  }

  it('locks at the save after a green Finish and writes finishedAt', async () => {
    await lockAsAnn()
    expect(paperA().reviewsLock?.['1']?.finishedAt).toMatch(/^\d{4}-/)
    expect(st().project!.papers.find((p) => p.id === 'c')!.reviewsLock?.['2']?.finishedAt).toBeDefined()
    expect(st().project!.papers.find((p) => p.id === 'b')!.reviewsLock).toBeUndefined()
    expect(JSON.parse(written.at(-1)!).papers[0].reviewsLock['1'].finishedAt).toBe(paperA().reviewsLock!['1'].finishedAt)
    expect(st().past).toEqual([])
    expect(finishReady(st().project, 'ann')).toBe(false)
  })

  it('does not lock when the Finish button is not green', async () => {
    st().choosePerson('ann')
    st().setFieldValue([], 'Relevant', 0, true)
    expect(finishReady(st().project, 'ann')).toBe(false)
    expect(await st().finishPersonWork()).toBe(true)
    expect(paperA().reviewsFinished).toEqual({ '1': true })
    expect(paperA().reviewsLock).toBeUndefined()
    expect(JSON.parse(written.at(-1)!).papers[0].reviewsLock).toBeUndefined()
  })

  it('drops the finish request when the person edits before the save', async () => {
    st().choosePerson('ann')
    answerAll()
    useStore.setState({ staleSave: { paths: [], refusal: null, merge: null, error: null, dismissed: true } })
    expect(await st().finishPersonWork()).toBe(false)
    st().setFieldValue([], 'Relevant', 0, false)
    st().setFieldValue([], 'Relevant', 0, true)
    expect(finishReady(st().project, 'ann')).toBe(true)
    useStore.setState({ staleSave: null })
    expect(await st().save()).toBe(true)
    expect(paperA().reviewsLock).toBeUndefined()
  })

  it('refuses every edit path on a locked seat', async () => {
    useStore.getState().loadFromText(
      projectText().replace('"strict":true', '"strict":true,"metadataEdit":"annotation"'),
      HANDLE,
      'strict.json',
    )
    await lockAsAnn()
    const before = st().project
    st().setFieldValue([], 'Relevant', 0, false)
    st().addInstance([], st().project!.schema[0])
    st().removeInstance([], 'Relevant', 0)
    st().setAnnotationFinished(false)
    expect(st().addHighlight(1, [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }])).toBeNull()
    expect(
      st().applyAiSuggestionsBatch([
        {
          paperId: 'a',
          reviewer: '1',
          suggestions: [{ path: 'Relevant', value: false, evidence: 'e', confidence: 0.9 }],
          usage: { provider: 'openai', model: 'gpt-5.5' },
        },
      ]).skipped,
    ).toBe(1)
    expect(st().applyMetadataEdits([{ paperId: 'a', values: { title: 'New' } }])).toBe(false)
    expect(st().project).toBe(before)
    expect(st().dirty).toBe(false)
  })

  it('lets only the Manager reopen, which writes reopenedAt', async () => {
    await lockAsAnn()
    st().reopenSeat('a', '1')
    expect(paperA().reviewsLock?.['1']?.finishedAt).toBeDefined()

    useStore.setState({ strictPerson: STRICT_MANAGER })
    st().reopenSeat('a', '1')
    expect(paperA().reviewsFinished).toEqual({})
    expect(paperA().reviewsLock?.['1']).toEqual({ reopenedAt: expect.stringMatching(/^\d{4}-/) })
    expect(st().dirty).toBe(true)
    st().selectPaper('a')
    st().selectReviewer('1')
    st().setFieldValue([], 'Relevant', 0, false)
    expect(paperA().reviews['1'].Relevant[0].value).toBe(false)
  })
})
