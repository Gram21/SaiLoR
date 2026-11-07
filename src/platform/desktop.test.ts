import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DesktopAdapter } from './desktop'
import { setBridge } from './bridge'
import { loadProject, serializeProject } from '../model/project'

function makeProjectText() {
  return serializeProject(
    loadProject(
      JSON.stringify({
        version: 1,
        config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
        papers: [
          { id: 'p1', title: 'Paper One', authors: ['A'], pdf: 'p1.pdf', annotations: { Relevant: [{ value: true }] } },
          { id: 'p2', title: 'Paper Two', authors: ['B'], pdf: 'p2.pdf', annotations: {} },
        ],
      }),
    ),
  )
}

afterEach(() => setBridge(null))

describe('DesktopAdapter.saveProject', () => {
  let saveProject: ReturnType<typeof vi.fn>

  beforeEach(() => {
    saveProject = vi.fn().mockResolvedValue({ stale: [] })
    setBridge({ saveProject } as never)
  })

  it('splits the logical project text into a meta-only project.json and per-paper annotation files', async () => {
    const adapter = new DesktopAdapter()
    await adapter.saveProject(makeProjectText(), { kind: 'electron', path: '/proj/project.json' })

    expect(saveProject).toHaveBeenCalledTimes(1)
    const [path, metaText, files] = saveProject.mock.calls[0]
    expect(path).toBe('/proj/project.json')

    const meta = JSON.parse(metaText)
    expect(meta.papers.every((p: Record<string, unknown>) => !('annotations' in p))).toBe(true)

    const p1 = files.find((f: { relPath: string }) => f.relPath === 'p1/consolidated.json')
    expect(p1.text).toContain('Relevant')
    const p2 = files.find((f: { relPath: string }) => f.relPath === 'p2/consolidated.json')
    expect(p2.text).toBeNull()
  })

  // [utest->req~plt-41~1]
  it('writes only the papers edited since the project was opened', async () => {
    // The whole point of the baseline: opening a project whose schema grew must
    // not rewrite every untouched paper's file into a shared git repository.
    const text = makeProjectText()
    const openPath = vi.fn().mockResolvedValue({ path: '/other/project.json', text, corrupt: [] })
    const setProjectDir = vi.fn().mockResolvedValue(undefined)
    setBridge({ saveProject, openPath, setProjectDir } as never)

    const adapter = new DesktopAdapter()
    await adapter.openRecent('/other/project.json')
    const handle = { kind: 'electron' as const, path: '/other/project.json' }

    // Nothing edited: nothing written, not even project.json.
    await adapter.saveProject(text, handle)
    expect(saveProject.mock.calls[0][1]).toBeNull()
    expect(saveProject.mock.calls[0][2]).toEqual([])

    // Edit p2 only: p1's files stay untouched.
    const project = loadProject(text)
    project.papers[1].annotations = { Relevant: [{ value: true }] }
    await adapter.saveProject(serializeProject(project), handle)
    const files = saveProject.mock.calls[1][2] as { relPath: string }[]
    expect(files.map((f) => f.relPath)).toEqual(['p2/consolidated.json'])
    expect(saveProject.mock.calls[1][1]).toBeNull()
  })

  // [utest->req~plt-440~1]
  // [utest->req~plt-442~1]
  it('streams papers on request and refuses to save the project until every paper was read', async () => {
    const text = makeProjectText()
    const whole = JSON.parse(text) as { papers: { id: string }[] }
    const only = (ids?: string[]) => JSON.stringify({ ...whole, papers: whole.papers.filter((p) => !ids || ids.includes(p.id)) })
    const head = JSON.stringify({ ...whole, papers: whole.papers.map((p) => ({ ...p, annotations: {} })) })
    const readPapers = vi.fn(async (ids?: string[]) => ({ text: only(ids), corrupt: ids ? [] : ['x/consolidated.json'] }))
    const openPath = vi.fn().mockResolvedValue({ path: '/s/project.json', text: head, corrupt: ['s.json'], readPapers })
    setBridge({ saveProject, openPath, setProjectDir: vi.fn().mockResolvedValue(undefined) } as never)
    const adapter = new DesktopAdapter()
    const handle = { kind: 'electron' as const, path: '/s/project.json' }

    const drained = await adapter.openRecent('/s/project.json')
    expect(drained).toMatchObject({ text: only(), corruptFiles: ['s.json', 'x/consolidated.json'] })
    expect(drained!.readPapers).toBeUndefined()

    const opened = await adapter.openRecent('/s/project.json', true)
    expect(opened).toMatchObject({ text: head, corruptFiles: ['s.json'] })
    expect(await opened!.readPapers!(['p1'])).toEqual({ papers: loadProject(only(['p1'])).papers, corruptFiles: [] })
    await expect(adapter.saveProject(text, handle)).rejects.toThrow(/still loading/)
    expect(saveProject).not.toHaveBeenCalled()
    await opened!.readPapers!(['p2'])
    await adapter.saveProject(text, handle)
    expect(saveProject.mock.calls[0][1]).toBeNull()
    expect(saveProject.mock.calls[0][2]).toEqual([])
  })

  // [utest->req~plt-43~1]
  it('writes only project.json when a new schema version renames a field nobody edited since', async () => {
    // The rename moves every file's answers on load; that alone must not make
    // each of those files count as edited, or one rename rewrites every
    // reviewer's file in a shared repository.
    const text = makeProjectText()
    const openPath = vi.fn().mockResolvedValue({ path: '/ren/project.json', text, corrupt: [] })
    const setProjectDir = vi.fn().mockResolvedValue(undefined)
    setBridge({ saveProject, openPath, setProjectDir } as never)
    const adapter = new DesktopAdapter()
    await adapter.openRecent('/ren/project.json')

    const renamed = JSON.parse(text)
    renamed.config.schema = [{ name: 'Include', type: 'boolean' }]
    renamed.schemaVersion = 'v1'
    renamed.schemaHistory = [{ id: 'v1', parents: [], at: '2026-09-23T10:00:00.000Z', moves: [{ from: ['Relevant'], to: ['Include'] }] }]
    await adapter.saveProject(JSON.stringify(renamed), { kind: 'electron', path: '/ren/project.json' })

    const [, metaText, files] = saveProject.mock.calls[0]
    expect(JSON.parse(metaText).schemaVersion).toBe('v1')
    expect(files).toEqual([])
  })

  // [utest->req~plt-42~1]
  it('deletes the files of a paper removed since the project was opened', async () => {
    // Nothing else ever revisits `annotations/<gone>/`: git does not notice it,
    // and a paper later given the same id would silently inherit its answers.
    const text = makeProjectText()
    const openPath = vi.fn().mockResolvedValue({ path: '/gone/project.json', text, corrupt: [] })
    const setProjectDir = vi.fn().mockResolvedValue(undefined)
    setBridge({ saveProject, openPath, setProjectDir } as never)

    const adapter = new DesktopAdapter()
    await adapter.openRecent('/gone/project.json')

    const project = loadProject(text)
    project.papers = project.papers.filter((p) => p.id !== 'p1')
    await adapter.saveProject(serializeProject(project), { kind: 'electron', path: '/gone/project.json' })

    const files = saveProject.mock.calls[0][2] as { relPath: string; text: string | null }[]
    const p1 = files.filter((f) => f.relPath.startsWith('p1/'))
    expect(p1.length).toBeGreaterThan(0)
    expect(p1.every((f) => f.text === null)).toBe(true)
    // p2 stays in the project and was not edited — still untouched.
    expect(files.some((f) => f.relPath.startsWith('p2/'))).toBe(false)
  })

  // [utest->req~plt-42~1]
  it('moves a paper\'s files when its id is renamed, leaving nothing behind', async () => {
    const text = makeProjectText()
    const openPath = vi.fn().mockResolvedValue({ path: '/renamed/project.json', text, corrupt: [] })
    const setProjectDir = vi.fn().mockResolvedValue(undefined)
    setBridge({ saveProject, openPath, setProjectDir } as never)

    const adapter = new DesktopAdapter()
    await adapter.openRecent('/renamed/project.json')

    const project = loadProject(text)
    project.papers[0].id = 'p1-renamed'
    await adapter.saveProject(serializeProject(project), { kind: 'electron', path: '/renamed/project.json' })

    const files = saveProject.mock.calls[0][2] as { relPath: string; text: string | null }[]
    const written = files.find((f) => f.relPath === 'p1-renamed/consolidated.json')
    expect(written?.text).toContain('Relevant')
    expect(files.find((f) => f.relPath === 'p1/consolidated.json')?.text).toBeNull()
  })

  // [utest->req~plt-41~1]
  it('forgets the baseline when a git call rewrites the working tree', async () => {
    // The baseline describes disk. A flow that rewrites the tree and then
    // forgets to reload would otherwise leave it describing a past that no
    // longer exists, and the next save would skip files it should have
    // written — so the seam drops it rather than trusting every caller.
    const text = makeProjectText()
    const openPath = vi.fn().mockResolvedValue({ path: '/gitty/project.json', text, corrupt: [] })
    const setProjectDir = vi.fn().mockResolvedValue(undefined)
    const gitPullAbort = vi.fn().mockResolvedValue({ ok: true, code: 0, stdout: '', stderr: '' })
    setBridge({ saveProject, openPath, setProjectDir, gitPullAbort } as never)

    const adapter = new DesktopAdapter()
    await adapter.openRecent('/gitty/project.json')
    await adapter.getGit()!.abortPull('/gitty')

    // Same unedited project: without the drop this would write nothing.
    await adapter.saveProject(text, { kind: 'electron', path: '/gitty/project.json' })
    const [, metaText, files] = saveProject.mock.calls[0]
    expect(metaText).not.toBeNull()
    expect((files as unknown[]).length).toBeGreaterThan(0)
  })

  // [utest->req~plt-457~1]
  it('keeps the baseline of a project opened while an earlier save was written', async () => {
    const text = makeProjectText()
    let finish = () => {}
    const slowSave = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (finish = () => r({ stale: [] }))))
      .mockResolvedValue({ stale: [] })
    const openPath = vi.fn().mockResolvedValue({ path: '/b/project.json', text, corrupt: [] })
    const setProjectDir = vi.fn().mockResolvedValue(undefined)
    setBridge({ saveProject: slowSave, openPath, setProjectDir } as never)

    const adapter = new DesktopAdapter()
    const first = adapter.saveProject(text, { kind: 'electron', path: '/a/project.json' })
    await adapter.openRecent('/b/project.json')
    finish()
    await first

    // B unedited: its baseline survived, so nothing is written.
    await adapter.saveProject(text, { kind: 'electron', path: '/b/project.json' })
    expect(slowSave.mock.calls[1][1]).toBeNull()
    expect(slowSave.mock.calls[1][2]).toEqual([])
  })

  it('throws when the handle has no path', async () => {
    const adapter = new DesktopAdapter()
    await expect(adapter.saveProject(makeProjectText(), { kind: 'electron' })).rejects.toThrow('Save as')
  })
})
