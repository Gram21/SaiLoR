import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SaveHandle } from '../platform/adapter'

/** Opening a project whose annotations folder other project files next to it
 *  use too proposes a split, and carries it out only when the project is saved. */
let shared: unknown = null
let splitCalls: { path: string; plan: unknown }[] = []
const PROJECT = (id: string, extra: object = {}) =>
  JSON.stringify({ version: 1, ...extra, config: { schema: [{ name: 'N', type: 'string' }] }, papers: [{ id, title: id, authors: [], pdf: `${id}.pdf` }] })

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  saveProject: async (_t: string, h: SaveHandle) => h,
  openRecent: async (path: string) => ({ text: PROJECT('p'), handle: { kind: 'electron' as const, path }, name: 'a.json' }),
  sharedAnnotations: async () => shared,
  splitAnnotations: async (path: string, plan: unknown) => {
    splitCalls.push({ path, plan })
    shared = null
  },
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))
const { useStore } = await import('./store')

beforeEach(() => {
  splitCalls = []
  shared = {
    folder: 'annotations',
    projects: [
      { path: '/d/a.json', name: 'a.json', text: PROJECT('p') },
      { path: '/d/b.json', name: 'b.json', text: PROJECT('p') },
    ],
    files: [
      { relPath: 'p/reviewer-1.json', text: '{"annotations":{"N":[{"value":"x"}]}}' },
      { relPath: 'q/reviewer-1.json', text: '{}' },
    ],
  }
  useStore.getState().loadFromText(PROJECT('p'), { kind: 'electron', path: '/d/a.json' }, 'a.json')
})

describe('a shared annotations folder', () => {
  it('is found and a split proposed, with a folder per project and the unclear files marked', async () => {
    await useStore.getState().checkSharedAnnotations()
    const split = useStore.getState().annotationsSplit!
    expect(split.projects.map((p) => p.folder)).toEqual(['a-annotations', 'b-annotations'])
    expect(split.rows.find((r) => r.relPath === 'p/reviewer-1.json')).toMatchObject({ ambiguous: true, targets: ['/d/a.json', '/d/b.json'] })
    expect(split.rows.find((r) => r.relPath === 'q/reviewer-1.json')!.targets).toEqual([])
  })

  it('is split with the confirmed choices, then the project reopened', async () => {
    await useStore.getState().checkSharedAnnotations()
    useStore.getState().setSplitTargets('p/reviewer-1.json', ['/d/b.json'])
    useStore.getState().setSplitFolder('/d/a.json', 'mine')
    await useStore.getState().runSplit()
    expect(splitCalls).toHaveLength(1)
    expect(splitCalls[0].plan).toMatchObject({
      folders: { '/d/a.json': 'mine', '/d/b.json': 'b-annotations' },
      rows: expect.arrayContaining([{ relPath: 'p/reviewer-1.json', targets: ['/d/b.json'] }]),
    })
    expect(useStore.getState().annotationsSplit).toBeNull()
  })

  it('is not split while the project has unsaved changes', async () => {
    await useStore.getState().checkSharedAnnotations()
    useStore.setState({ dirty: true })
    await useStore.getState().runSplit()
    expect(splitCalls).toEqual([])
    expect(useStore.getState().annotationsSplit?.error).toMatch(/Save the project first/)
  })

  it('proposes nothing when the folder is this project\'s alone', async () => {
    shared = null
    await useStore.getState().checkSharedAnnotations()
    expect(useStore.getState().annotationsSplit).toBeNull()
  })
})
