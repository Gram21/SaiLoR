import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'node:path'
import type { SaveHandle, ProjectLocation } from '../platform/adapter'

/**
 * "Save as" moves the project file, and a paper's `pdf` is stored relative to
 * that file — so the paths have to be re-derived or every PDF breaks at the new
 * location. The platform is stubbed with the same path math the Electron main
 * process runs, so the store's behaviour can be driven directly.
 */
let written: { text: string; handle: SaveHandle } | null = null
let destination: ProjectLocation | null = null

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  // loadFromText records the open project as a recent once it knows its title.
  rememberProject: () => {},
  forgetRecent: () => [],
  getOsInfo: () => null,
  pickProjectLocation: async () => destination,
  saveProject: async (text: string, handle: SaveHandle) => {
    written = { text, handle }
    return handle
  },
  // Mirrors the `paths:rebase` IPC handler.
  rebasePdfPaths: async (pdfPaths: string[], from: SaveHandle, to: SaveHandle) => {
    if (!from.path || !to.path) return pdfPaths
    const fromDir = path.dirname(from.path)
    const toDir = path.dirname(to.path)
    return pdfPaths.map((rel) =>
      path.relative(toDir, path.resolve(fromDir, rel)).split(path.sep).join('/'),
    )
  },
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')

const PROJECT = JSON.stringify({
  version: 1,
  config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
  papers: [
    { id: 'a', title: 'Paper A', authors: [], pdf: 'pdfs/a.pdf', annotations: {} },
    { id: 'b', title: 'Paper B', authors: [], pdf: 'pdfs/sub/b.pdf', annotations: {} },
  ],
})

const at = (p: string): ProjectLocation => ({
  handle: { kind: 'electron', path: p },
  name: p.split('/').pop()!,
  path: p,
})

/** The `pdf` paths as actually written to disk. */
function writtenPdfs(): string[] {
  const json = JSON.parse(written!.text) as { papers: { pdf: string }[] }
  return json.papers.map((p) => p.pdf)
}

describe('saveAs re-derives the PDF paths for the new location', () => {
  beforeEach(() => {
    written = null
    useStore.getState().loadFromText(PROJECT, { kind: 'electron', path: '/reviews/x.json' }, 'x.json')
  })

  it('leaves them alone when saving beside the original', async () => {
    destination = at('/reviews/copy.json')
    expect(await useStore.getState().saveAs()).toBe(true)
    expect(writtenPdfs()).toEqual(['pdfs/a.pdf', 'pdfs/sub/b.pdf'])
  })

  it('walks back out when saving to a sibling directory', async () => {
    destination = at('/other/y.json')
    expect(await useStore.getState().saveAs()).toBe(true)
    // Without the fix these stayed "pdfs/a.pdf" and resolved to /other/pdfs/a.pdf — nothing.
    expect(writtenPdfs()).toEqual(['../reviews/pdfs/a.pdf', '../reviews/pdfs/sub/b.pdf'])
  })

  it('shortens them when saving into the folder that holds the PDFs', async () => {
    destination = at('/reviews/pdfs/w.json')
    expect(await useStore.getState().saveAs()).toBe(true)
    expect(writtenPdfs()).toEqual(['a.pdf', 'sub/b.pdf'])
  })

  it('keeps the in-memory project in step with what was written', async () => {
    destination = at('/other/y.json')
    await useStore.getState().saveAs()
    const st = useStore.getState()
    expect(st.project!.papers.map((p) => p.pdf)).toEqual([
      '../reviews/pdfs/a.pdf',
      '../reviews/pdfs/sub/b.pdf',
    ])
    // The handle and name follow the new location, and the project is clean.
    expect(st.saveHandle?.path).toBe('/other/y.json')
    expect(st.projectName).toBe('y.json')
    expect(st.dirty).toBe(false)
  })

  it('writes nothing when the user cancels the picker', async () => {
    destination = null
    expect(await useStore.getState().saveAs()).toBe(false)
    expect(written).toBeNull()
  })
})
