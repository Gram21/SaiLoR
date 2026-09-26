import { describe, it, expect, vi } from 'vitest'
import type { SaveHandle } from '../platform/adapter'

/** A project started from a screening project picks up the screeners' PDF
 *  highlights for its papers after it opens. */
let source: { name: string; text: string } | null = null
const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  saveProject: async (_t: string, h: SaveHandle) => h,
  screeningSource: async () => source,
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))
const { useStore } = await import('./store')

const mark = { id: 'm', page: 1, kind: 'highlight', rects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.05 }], color: '#ffe066', comment: '', createdAt: '', updatedAt: '' }
const SCREENING = JSON.stringify({
  version: 1,
  config: { reviewers: 2, screening: { reasons: ['Off topic'] } },
  papers: [{ id: 'p1', title: 'P', authors: [], pdf: 'p.pdf', annotations: {}, reviewMarks: { 1: [mark] } }],
})
const annotation = (provenance: boolean) =>
  JSON.stringify({
    version: 1,
    ...(provenance
      ? { provenance: { kind: 'screening-import', source: { file: 'screening.json' }, importedAt: '2026-01-01T00:00:00Z', counts: { included: 1, undecided: 0, excluded: 0, carried: 1 } } }
      : {}),
    config: { schema: [{ name: 'N', type: 'string' }] },
    papers: [{ id: 'p1-2', title: 'P', authors: [], pdf: 'p.pdf', annotations: {} }],
  })

describe('screening highlights for a project started from screening', () => {
  it('are loaded by this project\'s paper ids', async () => {
    source = { name: 'screening.json', text: SCREENING }
    useStore.getState().loadFromText(annotation(true), { kind: 'electron', path: '/d/a.json' }, 'a.json')
    await useStore.getState().loadScreeningMarks()
    expect(useStore.getState().screeningMarks?.['p1-2']?.map((m) => m.seat)).toEqual(['1'])
  })

  it('are not looked for when the project was not started from screening', async () => {
    source = { name: 'screening.json', text: SCREENING }
    useStore.getState().loadFromText(annotation(false), { kind: 'electron', path: '/d/a.json' }, 'a.json')
    await useStore.getState().loadScreeningMarks()
    expect(useStore.getState().screeningMarks).toBeNull()
  })

  it('are absent when the screening project is gone', async () => {
    source = null
    useStore.getState().loadFromText(annotation(true), { kind: 'electron', path: '/d/a.json' }, 'a.json')
    await useStore.getState().loadScreeningMarks()
    expect(useStore.getState().screeningMarks).toBeNull()
  })
})
