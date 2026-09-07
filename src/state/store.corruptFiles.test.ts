import { describe, it, expect, vi } from 'vitest'

/**
 * An annotation file that isn't valid JSON (a leftover git merge conflict is
 * the usual cause) loads as absent, so the seat looks unannotated. Opening
 * such a project must say so — silence would let a reviewer redo or overwrite
 * work that is still sitting on disk.
 */
let corruptFiles: string[] = []

const PROJECT = JSON.stringify({
  version: 1,
  config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
  papers: [{ id: 'a', title: 'Paper A', authors: [], pdf: 'a.pdf', annotations: {} }],
})

const opened = (path: string) => ({
  text: PROJECT,
  handle: { kind: 'electron' as const, path },
  name: 'x.json',
  corruptFiles,
})

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  openProject: async () => opened('/x.json'),
  openRecent: async (id: string) => opened(id),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')

describe('corrupt annotation files are reported after open', () => {
  it('says nothing when every file parsed', async () => {
    corruptFiles = []
    await useStore.getState().openProject()
    expect(useStore.getState().loadError).toBeNull()
  })

  it('names the files and keeps the project loaded', async () => {
    corruptFiles = ['a/reviewer-1.json', 'a/marks-2.json']
    await useStore.getState().openProject()
    const err = useStore.getState().loadError
    expect(err?.message).toContain('2 annotation files could not be read')
    expect(err?.details).toContain('annotations/a/reviewer-1.json')
    expect(useStore.getState().project).not.toBeNull()
  })

  it('uses the singular wording for one file, via openRecent too', async () => {
    corruptFiles = ['a/consolidated.json']
    await useStore.getState().openRecent('/x.json')
    expect(useStore.getState().loadError?.message).toContain('One annotation file')
  })

  it('caps the list and counts the rest', async () => {
    corruptFiles = Array.from({ length: 13 }, (_, i) => `p${i}/reviewer-1.json`)
    await useStore.getState().openProject()
    const details = useStore.getState().loadError!.details
    expect(details.filter((d) => d.startsWith('annotations/'))).toHaveLength(10)
    expect(details).toContain('…and 3 more')
  })
})
