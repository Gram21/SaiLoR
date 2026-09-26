import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StaleSaveError, type SaveHandle } from '../platform/adapter'
import { loadProject } from '../model/project'

/**
 * A save whose files changed on disk since the project was read writes
 * nothing and asks: overwrite with mine, keep the disk's version of those
 * files, or combine the two field by field.
 */
let diskText = ''
let clash: string[] = []
let written: string[] = []

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  pickProjectLocation: async () => null,
  saveProject: async (text: string, handle: SaveHandle) => {
    if (clash.length > 0) {
      const paths = clash
      clash = []
      throw new StaleSaveError(paths)
    }
    written.push(text)
    return handle
  },
  rebasePdfPaths: async (pdfPaths: string[]) => pdfPaths,
  openRecent: async (path: string) => ({ text: diskText, handle: { kind: 'electron' as const, path }, name: 'x.json' }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')

const text = (notes: { a1?: string; a2?: string; b1?: string }, schema: object[] = [{ name: 'Note', type: 'string' }]) =>
  JSON.stringify({
    version: 1,
    config: { reviewers: 2, schema },
    papers: [
      { id: 'a', title: 'A', authors: [], pdf: 'a.pdf', annotations: {}, reviews: {
        ...(notes.a1 ? { 1: { Note: [{ value: notes.a1 }] } } : {}),
        ...(notes.a2 ? { 2: { Note: [{ value: notes.a2 }] } } : {}),
      } },
      { id: 'b', title: 'B', authors: [], pdf: 'b.pdf', annotations: {}, reviews: {
        ...(notes.b1 ? { 1: { Note: [{ value: notes.b1 }] } } : {}),
      } },
    ],
  })

const lastSaved = () => loadProject(written[written.length - 1])
const note = (p: ReturnType<typeof loadProject>, id: string, seat: string) =>
  p.papers.find((x) => x.id === id)?.reviews[seat]?.Note?.[0]?.value ?? null

function edit(paper: string, value: string) {
  useStore.getState().selectPaper(paper)
  useStore.getState().selectReviewer('1')
  useStore.getState().setFieldValue([], 'Note', 0, value)
}

beforeEach(() => {
  written = []
  clash = []
  useStore.getState().loadFromText(text({}), { kind: 'electron', path: '/x.json' }, 'x.json')
  edit('a', 'mine a')
  edit('b', 'mine b')
})

async function saveIntoClash(disk: string) {
  diskText = disk
  clash = ['annotations/a/reviewer-1.json']
  expect(await useStore.getState().save()).toBe(false)
}

describe('a save that meets files changed on disk', () => {
  it('writes nothing and asks, instead of raising an error', async () => {
    await saveIntoClash(text({ a1: 'theirs a' }))
    expect(written).toEqual([])
    expect(useStore.getState().staleSave?.paths).toEqual(['annotations/a/reviewer-1.json'])
    expect(useStore.getState().loadError).toBeNull()
    expect(useStore.getState().dirty).toBe(true)
  })

  it('overwrite: my version of the clashing file wins, their other changes stay', async () => {
    await saveIntoClash(text({ a1: 'theirs a', a2: 'theirs 2' }))
    await useStore.getState().resolveStaleSave('overwrite')
    const saved = lastSaved()
    expect(note(saved, 'a', '1')).toBe('mine a')
    expect(note(saved, 'a', '2')).toBe('theirs 2')
    expect(note(saved, 'b', '1')).toBe('mine b')
    expect(useStore.getState().staleSave).toBeNull()
    expect(useStore.getState().dirty).toBe(false)
  })

  it('discard: the clashing file keeps the disk version, my other edits are saved', async () => {
    await saveIntoClash(text({ a1: 'theirs a' }))
    await useStore.getState().resolveStaleSave('discard')
    const saved = lastSaved()
    expect(note(saved, 'a', '1')).toBe('theirs a')
    expect(note(saved, 'b', '1')).toBe('mine b')
    expect(note(useStore.getState().project!, 'a', '1')).toBe('theirs a')
  })

  it('combine: a field only one side changed merges without asking', async () => {
    await saveIntoClash(text({ a2: 'theirs 2' }))
    await useStore.getState().resolveStaleSave('combine')
    const saved = lastSaved()
    expect(note(saved, 'a', '1')).toBe('mine a')
    expect(note(saved, 'a', '2')).toBe('theirs 2')
    expect(useStore.getState().staleSave).toBeNull()
  })

  it('combine: a field both changed is a conflict the reviewer decides', async () => {
    await saveIntoClash(text({ a1: 'theirs a' }))
    await useStore.getState().resolveStaleSave('combine')
    const merge = useStore.getState().staleSave?.merge
    expect(merge?.conflicts).toHaveLength(1)
    expect(written).toEqual([])

    useStore.getState().takeAllStaleConflicts('theirs', merge!.conflicts.map((c) => c.id))
    await useStore.getState().finishStaleCombine()
    const saved = lastSaved()
    expect(note(saved, 'a', '1')).toBe('theirs a')
    expect(note(saved, 'b', '1')).toBe('mine b')
    expect(useStore.getState().staleSave).toBeNull()
  })

  it('combine: back returns to the choice without saving', async () => {
    await saveIntoClash(text({ a1: 'theirs a' }))
    await useStore.getState().resolveStaleSave('combine')
    useStore.getState().backToStaleChoice()
    expect(useStore.getState().staleSave?.merge).toBeNull()
    expect(written).toEqual([])
  })

  it('combine: a schema both sides extended is combined, not refused', async () => {
    const withField = (name: string) => [{ name: 'Note', type: 'string' }, { name, type: 'string' }]
    useStore.setState((s) => {
      s.project!.schema = loadProject(text({}, withField('Mine'))).schema
    })
    await saveIntoClash(text({ a1: 'theirs a' }, withField('Theirs')))
    await useStore.getState().resolveStaleSave('combine')
    const merge = useStore.getState().staleSave!.merge!
    useStore.getState().takeAllStaleConflicts('ours', merge.conflicts.map((c) => c.id))
    await useStore.getState().finishStaleCombine()
    expect(lastSaved().schema.map((d) => d.name)).toEqual(['Note', 'Mine', 'Theirs'])
  })

  it('combine refused explains why and leaves the other two choices', async () => {
    // One side shortened a repeatable list the other edited past the cut:
    // no field-level answer says which entry the edit belongs to.
    const F = [{ name: 'F', max: null, children: [{ name: 'C', type: 'string' }] }]
    const withEntries = (...cs: string[]) =>
      JSON.stringify({
        version: 1,
        config: { reviewers: 2, schema: F },
        papers: [{ id: 'a', title: 'A', authors: [], pdf: 'a.pdf', annotations: {}, reviews: {
          1: { F: cs.map((c) => ({ children: { C: [{ value: c }] } })) },
        } }],
      })
    useStore.getState().loadFromText(withEntries('x', 'y'), { kind: 'electron', path: '/x.json' }, 'x.json')
    useStore.setState((s) => {
      s.project!.papers[0].reviews['1'].F.splice(1, 1)
      s.dirty = true
    })
    await saveIntoClash(withEntries('x', 'y edited'))
    await useStore.getState().resolveStaleSave('combine')
    expect(useStore.getState().staleSave?.refusal).toMatch(/shortened on one side/)
    expect(written).toEqual([])

    await useStore.getState().resolveStaleSave('discard')
    expect(written).toHaveLength(1)
  })

  it('"Not now" writes nothing, and the next save asks again instead of writing', async () => {
    await saveIntoClash(text({ a1: 'theirs a' }))
    useStore.getState().dismissStaleSave()
    expect(useStore.getState().staleSave?.dismissed).toBe(true)

    expect(await useStore.getState().save()).toBe(false)
    expect(written).toEqual([])
    expect(useStore.getState().staleSave?.dismissed).toBe(false)
  })
})
