import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'

// Same localStorage polyfill as store.reviewers.test.ts — the reading
// position is persisted the same per-machine way the reviewer seat is.
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
 * "Continue where you left off": `noteReadingPosition`/`loadFromText`'s use
 * of `loadReadingPosition` — reopening a project should land on the same
 * paper (and, via `initialPdfPosition`, the same PDF page) a reviewer was
 * last looking at, overriding `firstUnfinishedPaperId`'s default rather than
 * only applying when they happen to agree.
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

const schema = [{ name: 'A', type: 'string' as const, required: true }]

// p1 is finished, so firstUnfinishedPaperId's default would land on p2 —
// any test restoring p1 via a stored position is proving a real override,
// not a coincidence.
const twoPaperProject = JSON.stringify({
  version: 1,
  config: { schema },
  papers: [
    { id: 'p1', title: 'One', authors: [], pdf: 'a.pdf', annotations: { A: [{ value: 'x' }] }, finished: true },
    { id: 'p2', title: 'Two', authors: [], pdf: 'b.pdf', annotations: {} },
  ],
})

const st = () => useStore.getState()
const handleAt = (path: string): SaveHandle => ({ kind: 'electron', path })

beforeEach(() => {
  localStorage.clear()
})

describe('reading position is persisted per project', () => {
  it('restores the paper and initial page when the same project (by handle path) is reopened', () => {
    const handle = handleAt('/reviews/x.json')
    st().loadFromText(twoPaperProject, handle, 'x.json')
    expect(st().currentPaperId).toBe('p2') // the default landing, before anything is noted

    st().noteReadingPosition('p1', 7)
    st().closeProject()

    st().loadFromText(twoPaperProject, handle, 'x.json')
    expect(st().currentPaperId).toBe('p1')
    expect(st().initialPdfPosition).toEqual({ paperId: 'p1', page: 7 })
  })

  it('falls back to firstUnfinishedPaperId when nothing was ever noted', () => {
    st().loadFromText(twoPaperProject, handleAt('/reviews/fresh.json'), 'fresh.json')
    expect(st().currentPaperId).toBe('p2')
    expect(st().initialPdfPosition).toBeNull()
  })

  it('ignores a stored position naming a paper that no longer exists', () => {
    const handle = handleAt('/reviews/y.json')
    st().loadFromText(twoPaperProject, handle, 'y.json')
    st().noteReadingPosition('p1', 3)

    const onePaperProject = JSON.stringify({
      version: 1,
      config: { schema },
      papers: [{ id: 'p2', title: 'Two', authors: [], pdf: 'b.pdf', annotations: {} }],
    })
    st().loadFromText(onePaperProject, handle, 'y.json')
    expect(st().currentPaperId).toBe('p2')
    expect(st().initialPdfPosition).toBeNull()
  })

  it('does not leak a position across two different projects', () => {
    st().loadFromText(twoPaperProject, handleAt('/reviews/a.json'), 'a.json')
    st().noteReadingPosition('p1', 5)

    st().loadFromText(twoPaperProject, handleAt('/reviews/b.json'), 'b.json')
    expect(st().currentPaperId).toBe('p2')
    expect(st().initialPdfPosition).toBeNull()
  })

  it('does not persist or restore anything for a project with no stable handle', () => {
    st().loadFromText(twoPaperProject, null, 'test.json')
    expect(() => st().noteReadingPosition('p1', 2)).not.toThrow()
    st().loadFromText(twoPaperProject, null, 'test.json')
    expect(st().currentPaperId).toBe('p2')
    expect(st().initialPdfPosition).toBeNull()
  })

  it('clearInitialPdfPosition drops the pending request', () => {
    const handle = handleAt('/reviews/z.json')
    st().loadFromText(twoPaperProject, handle, 'z.json')
    st().noteReadingPosition('p1', 4)
    st().closeProject()
    st().loadFromText(twoPaperProject, handle, 'z.json')
    expect(st().initialPdfPosition).not.toBeNull()

    st().clearInitialPdfPosition()
    expect(st().initialPdfPosition).toBeNull()
  })
})
