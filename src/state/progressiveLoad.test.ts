// [utest->req~plt-440~1]
// [utest->req~plt-442~1]
// [utest->req~plt-443~1]
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * A split project opens from its head (every paper, no answers) and the store
 * then reads the papers in batches. Until the last batch lands only the papers
 * read so far are in the project, so saving waits, and so does anything that
 * would read papers that are not there yet.
 */
const N = 4500
const config = { schema: [{ name: 'Relevant', type: 'boolean' }] }
const papers = Array.from({ length: N }, (_, i) => ({
  id: `p${i}`,
  title: `Paper ${i}`,
  authors: [],
  pdf: `p${i}.pdf`,
  annotations: { Relevant: [{ value: true }] },
}))
const head = JSON.stringify({ version: 1, config, papers: papers.map((p) => ({ ...p, annotations: {} })) })
const only = (ids: string[]) => {
  const wanted = new Set(ids)
  return JSON.stringify({ version: 1, config, papers: papers.filter((p) => wanted.has(p.id)) })
}

let gate: (() => void)[] = []
let fail = false
const readPapers = vi.fn(async (ids: string[]) => {
  await new Promise<void>((resolve) => gate.push(resolve))
  if (fail) throw new Error('disk gone')
  return { text: only(ids), corruptFiles: ids[0] === 'p2000' ? ['p2000/consolidated.json'] : [] }
})

const opened = (path: string) => ({
  text: head,
  handle: { kind: 'electron' as const, path },
  name: 'project.json',
  corruptFiles: ['head.json'],
  readPapers,
})

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  openProject: vi.fn(async () => opened('/big/project.json')),
  openRecent: vi.fn(async (id: string) => opened(id)),
  saveProject: vi.fn(async () => ({ stale: [] })),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')
const st = () => useStore.getState()

/** Lets the batch the store is waiting for arrive. */
async function release() {
  await vi.waitFor(() => expect(gate.length).toBe(1))
  gate.shift()!()
}

beforeEach(() => {
  st().closeProject()
  gate = []
  fail = false
  readPapers.mockClear()
  mockPlatform.saveProject.mockClear()
})

describe('progressive project loading', () => {
  it('fills the paper list batch by batch, then reports every corrupt file', async () => {
    const done = st().openRecent('/big/project.json')
    await vi.waitFor(() => expect(gate.length).toBe(1))
    expect(st().loadState).toBe('loading')
    expect(st().loadProgress).toEqual({ loaded: 0, total: N })
    expect(st().project!.papers).toHaveLength(0)

    await release()
    await vi.waitFor(() => expect(st().loadProgress?.loaded).toBe(2000))
    expect(st().project!.papers).toHaveLength(2000)
    expect(st().project!.papers[0].annotations.Relevant).toEqual([{ value: true }])
    expect(st().currentPaperId).toBe('p0')

    await release()
    await release()
    await done
    expect(readPapers.mock.calls.map((c) => c[0].length)).toEqual([2000, 2000, 500])
    expect(st().loadState).toBe('ready')
    expect(st().loadProgress).toBeNull()
    expect(st().project!.papers.map((p) => p.id)).toEqual(papers.map((p) => p.id))
    expect(st().corruptFiles).toEqual(['head.json', 'p2000/consolidated.json'])
  })

  it('refuses to save until every paper has loaded, then saves the whole project', async () => {
    const done = st().openProject()
    await release()
    await vi.waitFor(() => expect(st().loadProgress?.loaded).toBe(2000))

    expect(await st().save()).toBe(false)
    expect(await st().saveAs()).toBe(false)
    expect(st().loadError?.message).toMatch(/still loading/)
    expect(mockPlatform.saveProject).not.toHaveBeenCalled()

    await release()
    await release()
    await done
    st().setFieldValue([], 'Relevant', 0, false)
    expect(await st().save()).toBe(true)
    const [text] = mockPlatform.saveProject.mock.calls[0] as unknown as [string]
    expect(JSON.parse(text).papers).toHaveLength(N)
  })

  it('keeps per-paper edits made while loading, and undo keeps the later batches', async () => {
    const done = st().openRecent('/big/project.json')
    await release()
    await vi.waitFor(() => expect(st().currentPaperId).toBe('p0'))
    st().setFieldValue([], 'Relevant', 0, false)

    await release()
    await release()
    await done
    expect(st().project!.papers[0].annotations.Relevant).toEqual([{ value: false }])
    st().undo()
    expect(st().project!.papers).toHaveLength(N)
    expect(st().project!.papers[0].annotations.Relevant).toEqual([{ value: true }])
  })

  it('stops reading once the project is closed', async () => {
    const done = st().openRecent('/big/project.json')
    await release()
    await vi.waitFor(() => expect(gate.length).toBe(1))
    st().closeProject()
    gate.shift()!()
    await done
    expect(st().project).toBeNull()
    expect(st().loadState).toBe('idle')
    expect(readPapers).toHaveBeenCalledTimes(2)
  })

  it('closes a project whose batch cannot be read, and says why', async () => {
    const done = st().openRecent('/big/project.json')
    await release()
    fail = true
    await release()
    await done
    expect(st().project).toBeNull()
    expect(st().loadState).toBe('idle')
    expect(st().loadError?.details.join()).toContain('disk gone')
  })
})
