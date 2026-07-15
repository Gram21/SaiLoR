import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'

/**
 * `runValidation` is the store-layer wiring around `validateProject`: this
 * file pins that both halves of its result — the issues, and the papers
 * skipped for having no annotations at all — actually reach the store, and
 * that neither lingers into the next project once one is loaded or closed.
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

const PROJECT = JSON.stringify({
  version: 1,
  title: 'Validation',
  config: {
    schema: [
      { name: 'Relevant', type: 'boolean', required: true },
      { name: 'Year', type: 'number', required: true },
    ],
  },
  papers: [
    // Untouched: every field at its blank default.
    { id: 'untouched', title: 'Untouched', authors: [], pdf: 'u.pdf', annotations: {} },
    // In progress: Relevant answered, Year still required and empty.
    {
      id: 'started',
      title: 'Started',
      authors: [],
      pdf: 's.pdf',
      annotations: { Relevant: [{ value: true }], Year: [{ value: null }] },
    },
    // Fully answered.
    {
      id: 'done',
      title: 'Done',
      authors: [],
      pdf: 'd.pdf',
      annotations: { Relevant: [{ value: true }], Year: [{ value: 2021 }] },
    },
  ],
})

const st = () => useStore.getState()

beforeEach(() => {
  st().loadFromText(PROJECT, null, 'test.json')
})

describe('runValidation', () => {
  it('validates only papers with at least one annotation, and lists the rest as unannotated', () => {
    st().runValidation()

    expect(st().validation).not.toBeNull()
    expect(st().validation!.every((i) => i.paperId === 'started')).toBe(true)
    expect(st().validation!.length).toBeGreaterThan(0)

    expect(st().validationUnannotated).toEqual([{ paperId: 'untouched', paperTitle: 'Untouched' }])
    expect(st().validationOpen).toBe(true)
  })

  it('is a no-op without a loaded project', () => {
    st().closeProject()
    st().runValidation()
    expect(st().validation).toBeNull()
    expect(st().validationUnannotated).toBeNull()
  })
})

describe('validation state does not outlive its project', () => {
  beforeEach(() => {
    st().runValidation()
    expect(st().validation).not.toBeNull()
    expect(st().validationUnannotated).not.toBeNull()
  })

  it('closeProject clears both', () => {
    st().closeProject()
    expect(st().validation).toBeNull()
    expect(st().validationUnannotated).toBeNull()
    expect(st().validationOpen).toBe(false)
  })

  it('loading a different project clears both', () => {
    st().loadFromText(PROJECT, null, 'again.json')
    expect(st().validation).toBeNull()
    expect(st().validationUnannotated).toBeNull()
    expect(st().validationOpen).toBe(false)
  })
})
