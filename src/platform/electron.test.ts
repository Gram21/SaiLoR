import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ElectronAdapter } from './electron'
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

describe('ElectronAdapter.saveProject', () => {
  let saveProject: ReturnType<typeof vi.fn>

  beforeEach(() => {
    saveProject = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { slr: unknown }).slr = { saveProject }
  })

  it('splits the logical project text into a meta-only project.json and per-paper annotation files', async () => {
    const adapter = new ElectronAdapter()
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

  it('writes only the papers edited since the project was opened', async () => {
    // The whole point of the baseline: opening a project whose schema grew must
    // not rewrite every untouched paper's file into a shared git repository.
    const text = makeProjectText()
    const openPath = vi.fn().mockResolvedValue({ path: '/other/project.json', text, corrupt: [] })
    const setProjectDir = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { slr: unknown }).slr = { saveProject, openPath, setProjectDir }

    const adapter = new ElectronAdapter()
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

  it('throws when the handle has no path', async () => {
    const adapter = new ElectronAdapter()
    await expect(adapter.saveProject(makeProjectText(), { kind: 'electron' })).rejects.toThrow('Save as')
  })
})
