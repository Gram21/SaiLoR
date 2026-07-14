import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry } from '../platform/recents'

let saveResult = true
let saved = 0
let recents: RecentEntry[] = []
/** Which ids the platform still considers reachable. */
let existing = new Set<string>()

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => recents,
  rememberProject: () => {},
  forgetRecent: (id: string) => {
    recents = recents.filter((r) => r.id !== id)
    return recents
  },
  checkRecents: async (entries: RecentEntry[]) =>
    entries.map((e) => ({ ...e, available: existing.has(e.id) })),
  getOsInfo: () => null,
  openRecent: async (id: string) => (existing.has(id) ? { text: PROJECT, handle: {}, name: id } : null),
  saveProject: async () => ({ kind: 'electron' as const, path: '/x.json' }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')

const PROJECT = JSON.stringify({
  version: 1,
  title: 'My Review',
  config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
  papers: [{ id: 'p1', title: 'A Paper', authors: [], pdf: 'a.pdf', annotations: {} }],
})

function openProject() {
  useStore.getState().loadFromText(PROJECT, { kind: 'electron', path: '/r.json' }, 'r.json')
}

beforeEach(() => {
  saveResult = true
  saved = 0
  recents = []
  existing = new Set()
  // Stub save() so the close flow can be driven without real I/O.
  useStore.setState({
    save: async () => {
      saved++
      if (saveResult) useStore.setState({ dirty: false })
      return saveResult
    },
  })
})

describe('closing a project', () => {
  it('returns to the start screen immediately when there is nothing to save', () => {
    openProject()
    expect(useStore.getState().dirty).toBe(false)

    useStore.getState().requestCloseProject()

    expect(useStore.getState().closePromptOpen).toBe(false) // no prompt
    expect(useStore.getState().project).toBeNull()
    expect(useStore.getState().projectTitle).toBe('')
  })

  it('asks first when there are unsaved changes', () => {
    openProject()
    useStore.setState({ dirty: true })

    useStore.getState().requestCloseProject()

    expect(useStore.getState().closePromptOpen).toBe(true)
    // Nothing closed yet — the user has not answered.
    expect(useStore.getState().project).not.toBeNull()
  })

  it('Cancel keeps the project open and still dirty', async () => {
    openProject()
    useStore.setState({ dirty: true })
    useStore.getState().requestCloseProject()

    await useStore.getState().resolveClosePrompt('cancel')

    expect(useStore.getState().closePromptOpen).toBe(false)
    expect(useStore.getState().project).not.toBeNull()
    expect(useStore.getState().dirty).toBe(true)
    expect(saved).toBe(0)
  })

  it("Don't Save closes without writing", async () => {
    openProject()
    useStore.setState({ dirty: true })
    useStore.getState().requestCloseProject()

    await useStore.getState().resolveClosePrompt('discard')

    expect(useStore.getState().project).toBeNull()
    expect(saved).toBe(0)
  })

  it('Save writes, then closes', async () => {
    openProject()
    useStore.setState({ dirty: true })
    useStore.getState().requestCloseProject()

    await useStore.getState().resolveClosePrompt('save')

    expect(saved).toBe(1)
    expect(useStore.getState().project).toBeNull()
  })

  it('a failed save leaves the project open, so no work is lost', async () => {
    openProject()
    useStore.setState({ dirty: true })
    useStore.getState().requestCloseProject()
    saveResult = false

    await useStore.getState().resolveClosePrompt('save')

    expect(saved).toBe(1)
    expect(useStore.getState().project).not.toBeNull()
    expect(useStore.getState().dirty).toBe(true)
  })

  it('does nothing when no project is open', () => {
    useStore.setState({ project: null })
    useStore.getState().requestCloseProject()
    expect(useStore.getState().closePromptOpen).toBe(false)
  })
})

describe('recents availability', () => {
  it('marks entries whose file is gone as unavailable, without dropping them', async () => {
    recents = [
      { id: '/here.json', name: 'here.json' },
      { id: '/gone.json', name: 'gone.json' },
    ]
    existing = new Set(['/here.json'])

    await useStore.getState().refreshRecents()

    const list = useStore.getState().recents
    // Both are kept — a missing file may come back (unplugged drive, sync).
    expect(list).toHaveLength(2)
    expect(list.map((r) => r.available)).toEqual([true, false])
  })

  it('opening a project that has vanished marks it unavailable rather than forgetting it', async () => {
    recents = [{ id: '/gone.json', name: 'gone.json', available: true }]
    useStore.setState({ recents })
    existing = new Set() // the file is gone

    await useStore.getState().openRecent('/gone.json')

    const list = useStore.getState().recents
    expect(list).toHaveLength(1)
    expect(list[0].available).toBe(false)
    expect(useStore.getState().loadError).not.toBeNull()
  })

  it('the user can still remove an unavailable entry', () => {
    recents = [{ id: '/gone.json', name: 'gone.json', available: false }]
    useStore.setState({ recents })

    useStore.getState().forgetRecent('/gone.json')

    expect(useStore.getState().recents).toHaveLength(0)
  })
})
