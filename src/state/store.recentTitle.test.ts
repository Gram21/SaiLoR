import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry } from '../platform/recents'

/**
 * The recents list shows each project's title, but that title was only ever
 * written when the project was *opened*. Renaming a project (e.g. in the project
 * editor) therefore left the old title on screen. `refreshRecents` now re-reads
 * it from the file, which is what these tests pin down.
 *
 * `titlesOnDisk` stands in for the actual files.
 */
let titlesOnDisk = new Map<string, string | undefined>()
let stored: RecentEntry[] = []

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => stored,
  rememberProject: () => {},
  forgetRecent: () => [],
  getOsInfo: () => null,
  // Mirrors the adapters: existence + the title as it is on disk *right now*.
  checkRecents: async (entries: RecentEntry[]) =>
    entries.map((e) => {
      const exists = titlesOnDisk.has(e.id)
      return {
        ...e,
        available: exists,
        // A file that is gone keeps whatever title we last knew.
        title: exists ? titlesOnDisk.get(e.id) : e.title,
      }
    }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')

beforeEach(() => {
  titlesOnDisk = new Map()
  stored = []
})

describe('recent project titles are re-read from the file', () => {
  it('picks up a title changed on disk since the project was last opened', async () => {
    stored = [{ id: '/r.json', name: 'r.json', title: 'Old Title' }]
    titlesOnDisk.set('/r.json', 'New Title')

    await useStore.getState().refreshRecents()

    expect(useStore.getState().recents[0].title).toBe('New Title')
  })

  it('falls back to the file name when the title was removed', async () => {
    stored = [{ id: '/r.json', name: 'r.json', title: 'Old Title' }]
    titlesOnDisk.set('/r.json', undefined) // file exists, but no longer sets a title

    await useStore.getState().refreshRecents()

    const entry = useStore.getState().recents[0]
    expect(entry.title).toBeUndefined()
    // The UI shows `title || name`, so this reads as "r.json" again.
    expect(entry.title || entry.name).toBe('r.json')
  })

  it('picks up a title added to a project that had none', async () => {
    stored = [{ id: '/r.json', name: 'r.json' }]
    titlesOnDisk.set('/r.json', 'Freshly Named')

    await useStore.getState().refreshRecents()

    expect(useStore.getState().recents[0].title).toBe('Freshly Named')
  })

  it('keeps the last known title for a file that has gone', async () => {
    stored = [{ id: '/gone.json', name: 'gone.json', title: 'Known Title' }]
    // Not in titlesOnDisk → the file is missing.

    await useStore.getState().refreshRecents()

    const entry = useStore.getState().recents[0]
    expect(entry.available).toBe(false)
    // Still labelled usefully rather than reverting to a bare file name.
    expect(entry.title).toBe('Known Title')
  })

  it('refreshes every entry, not just the first', async () => {
    stored = [
      { id: '/a.json', name: 'a.json', title: 'Stale A' },
      { id: '/b.json', name: 'b.json', title: 'Stale B' },
    ]
    titlesOnDisk.set('/a.json', 'Fresh A')
    titlesOnDisk.set('/b.json', 'Fresh B')

    await useStore.getState().refreshRecents()

    expect(useStore.getState().recents.map((r) => r.title)).toEqual(['Fresh A', 'Fresh B'])
  })
})
