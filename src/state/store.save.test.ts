import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SaveHandle } from '../platform/adapter'

/**
 * `save()` snapshots `project` before the async `saveProject` write and, once
 * it resolves, used to clear `dirty` unconditionally. Nothing blocks input
 * while that write is in flight (`Field.tsx` writes every keystroke straight
 * to the store), so a keystroke landing mid-write set `dirty` back to `true`
 * for itself — and the unconditional clear then threw that away: the toolbar
 * said "Saved", and Cmd+Q's guard would not have prompted, for an edit that
 * never reached disk.
 */
let written: { text: string; handle: SaveHandle } | null = null
let mutateDuringSave: (() => void) | null = null
let recentText: string = ''

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  pickProjectLocation: async () => null,
  saveProject: async (text: string, handle: SaveHandle) => {
    written = { text, handle }
    // A real write is hundreds of ms of async multi-file IPC; yielding once
    // here before running the hook reproduces "something else ran while the
    // write was in flight" without needing fake timers.
    await Promise.resolve()
    mutateDuringSave?.()
    return handle
  },
  rebasePdfPaths: async (pdfPaths: string[]) => pdfPaths,
  openRecent: async (path: string) => ({
    text: recentText,
    handle: { kind: 'electron' as const, path },
    name: 'x.json',
  }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')

const PROJECT = JSON.stringify({
  version: 1,
  config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
  papers: [{ id: 'a', title: 'Paper A', authors: [], pdf: 'a.pdf', annotations: {} }],
})

describe('save() does not clear dirty (or lose the edit) for a change made during the write', () => {
  beforeEach(() => {
    written = null
    mutateDuringSave = null
    useStore.getState().loadFromText(PROJECT, { kind: 'electron', path: '/x.json' }, 'x.json')
    useStore.getState().selectPaper('a')
  })

  it('leaves dirty true and keeps the newer value when the project changes mid-write', async () => {
    mutateDuringSave = () => useStore.getState().setFieldValue([], 'Relevant', 0, true)

    expect(await useStore.getState().save()).toBe(true)

    const st = useStore.getState()
    expect(st.dirty).toBe(true)
    expect(st.busy).toBe(false)
    expect(st.project!.papers[0].annotations.Relevant[0].value).toBe(true)
    // The handle/timestamp bookkeeping for the write that did happen still
    // applies — only `dirty` (and the project snapshot) must reflect the
    // newer, unsaved edit.
    expect(st.saveHandle).toEqual({ kind: 'electron', path: '/x.json' })
    expect(st.lastSavedAt).not.toBeNull()
    // The value that was actually serialized is the pre-edit one.
    expect(JSON.parse(written!.text).papers[0].annotations).toEqual({})
  })

  it('clears dirty normally when nothing changes during the write', async () => {
    useStore.getState().setFieldValue([], 'Relevant', 0, true)
    expect(useStore.getState().dirty).toBe(true)

    expect(await useStore.getState().save()).toBe(true)

    expect(useStore.getState().dirty).toBe(false)
  })
})

describe('resyncProjectFromDisk clears undo/redo history', () => {
  beforeEach(() => {
    written = null
    mutateDuringSave = null
    useStore.getState().loadFromText(PROJECT, { kind: 'electron', path: '/x.json' }, 'x.json')
    useStore.getState().selectPaper('a')
  })

  it("a Ctrl+Z after a resync cannot resurrect what the resync just replaced", async () => {
    // The edit an undo would otherwise restore — this is the state a stale
    // history entry would bring back if past/future survived the resync.
    useStore.getState().setFieldValue([], 'Relevant', 0, true)
    expect(useStore.getState().past.length).toBeGreaterThan(0)

    // Simulate a field-level git commit/discard rewriting the file on disk
    // out from under the open project (see gitStore.ts's runCommit/runDiscard).
    recentText = JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
      papers: [{ id: 'a', title: 'Paper A', authors: [], pdf: 'a.pdf', annotations: {} }],
    })
    await useStore.getState().resyncProjectFromDisk()

    expect(useStore.getState().past).toEqual([])
    expect(useStore.getState().future).toEqual([])

    // Undo must be a no-op now — not a resurrection of the pre-resync project.
    const afterResync = useStore.getState().project
    useStore.getState().undo()
    expect(useStore.getState().project).toBe(afterResync)
    // The pre-resync edit (Relevant = true) must not come back.
    expect(useStore.getState().project!.papers[0].annotations.Relevant?.[0]?.value).toBe(false)
  })
})
