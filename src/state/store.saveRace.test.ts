import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SaveHandle } from '../platform/adapter'
import { loadProject } from '../model/project'

const config = { schema: [{ name: 'Relevant', type: 'boolean' }] }
const paper = (id: string, value?: boolean) => ({
  id,
  title: id,
  authors: [],
  pdf: `${id}.pdf`,
  annotations: value === undefined ? {} : { Relevant: [{ value }] },
})
const text = (...papers: ReturnType<typeof paper>[]) => JSON.stringify({ version: 1, config, papers })

const SMALL = text(paper('s0', true))
const OTHER = text(paper('o0'))
const BIG = [paper('b0', true), paper('b1', true)]

let saveGates: (() => void)[] = []
let batchGates: (() => void)[] = []
const saves: { text: string; handle: SaveHandle }[] = []

const opened = (path: string, body: string) => ({
  text: body,
  handle: { kind: 'electron' as const, path },
  name: path,
  corruptFiles: [],
})

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  pickProjectLocation: async () => ({ handle: { kind: 'electron' as const, path: '/as/project.json' }, name: 'as.json' }),
  annotationsDirUsers: async () => [],
  rebasePdfPaths: async (pdfPaths: string[]) => pdfPaths,
  openRecent: async (path: string) => {
    if (path === '/small/project.json') return opened(path, SMALL)
    if (path === '/other/project.json') return opened(path, OTHER)
    // The big project streams: its papers arrive only when a batch gate opens.
    return {
      ...opened(path, text(...BIG.map((p) => ({ ...p, annotations: {} })))),
      readPapers: async (ids: string[]) => {
        await new Promise<void>((r) => batchGates.push(r))
        return { papers: loadProject(text(...BIG.filter((p) => ids.includes(p.id)))).papers, corruptFiles: [] }
      },
    }
  },
  saveProject: (body: string, handle: SaveHandle) => {
    saves.push({ text: body, handle })
    return new Promise<SaveHandle>((r) => saveGates.push(() => r(handle)))
  },
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')
const st = () => useStore.getState()
const releaseSave = () => saveGates.shift()!()

// [utest->req~plt-457~1]
describe('a save started before another project opens', () => {
  beforeEach(async () => {
    saveGates = []
    batchGates = []
    saves.length = 0
    st().closeProject()
    await st().openRecent('/small/project.json')
    useStore.setState((s) => {
      s.loadError = null
    })
  })

  it('does not write a queued save once another project is loading', async () => {
    const first = st().save()
    await vi.waitFor(() => expect(saveGates).toHaveLength(1))
    const queued = st().save()
    const open = st().openRecent('/big/project.json')
    await vi.waitFor(() => expect(batchGates).toHaveLength(1))

    releaseSave()
    expect(await first).toBe(true)
    expect(await queued).toBe(false)
    expect(saves).toHaveLength(1)
    expect(saves[0].handle.path).toBe('/small/project.json')

    batchGates.shift()!()
    await open
    expect(st().project!.papers.map((p) => p.id)).toEqual(['b0', 'b1'])
  })

  it('keeps the newly opened project on its own file', async () => {
    const first = st().save()
    await vi.waitFor(() => expect(saveGates).toHaveLength(1))
    await st().openRecent('/other/project.json')
    releaseSave()
    expect(await first).toBe(true)

    expect(st().saveHandle).toEqual({ kind: 'electron', path: '/other/project.json' })
    st().setFieldValue([], 'Relevant', 0, true)
    const next = st().save()
    await vi.waitFor(() => expect(saves).toHaveLength(2))
    releaseSave()
    await next
    expect(saves[1].handle.path).toBe('/other/project.json')
    expect(JSON.parse(saves[1].text).papers.map((p: { id: string }) => p.id)).toEqual(['o0'])
  })

  it('keeps the newly opened project on its own file after Save As', async () => {
    const first = st().saveAs()
    await vi.waitFor(() => expect(saveGates).toHaveLength(1))
    await st().openRecent('/other/project.json')
    releaseSave()
    expect(await first).toBe(true)

    expect(st().saveHandle).toEqual({ kind: 'electron', path: '/other/project.json' })
    expect(st().projectName).toBe('/other/project.json')
  })
})
