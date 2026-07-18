import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'node:path'
import type { ProjectLocation, SaveHandle } from '../platform/adapter'

/**
 * `changeLocation` (the editor's "Change…" button, and the same code `saveAs`
 * runs) has to re-derive every paper's `pdf`, which is stored relative to the
 * project JSON. Two mechanisms cover two kinds of paper — a PDF added in this
 * session (absolute source known) and one loaded from the opened file
 * (`sourcePath` deliberately undefined) — and only the first was implemented,
 * so moving an *opened* project silently pointed every PDF at nothing.
 */
let destination: ProjectLocation | null = null

const mockPlatform = {
  kind: 'electron' as const,
  getOsInfo: () => null,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  openProject: async () => ({
    text: PROJECT,
    handle: { kind: 'electron' as const, path: '/reviews/a/review.json' },
    name: 'review.json',
  }),
  openRecent: async () => null,
  saveProject: async (_t: string, h: SaveHandle) => h,
  pickProjectLocation: async () => destination,
  // Mirrors the Electron adapter: re-anchor a JSON-relative path from one
  // project directory to another.
  rebasePdfPaths: async (paths: string[], from: SaveHandle, to: SaveHandle) => {
    if (!from.path || !to.path) return paths
    const fromDir = path.dirname(from.path)
    const toDir = path.dirname(to.path)
    return paths.map((rel) =>
      path.relative(toDir, path.resolve(fromDir, rel)).split(path.sep).join('/'),
    )
  },
  relativePdfPaths: async () => [],
  getPdfSource: async () => ({ url: '' }),
  pickPdfs: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore } = await import('./editorStore')
const es = () => useEditorStore.getState()

const PROJECT = JSON.stringify({
  version: 1,
  config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
  papers: [
    { id: 'a', title: 'A', authors: [], pdf: 'pdfs/a.pdf', annotations: { Relevant: [{ value: false }] } },
    { id: 'b', title: 'B', authors: [], pdf: 'pdfs/sub/b.pdf', annotations: { Relevant: [{ value: false }] } },
  ],
})

describe('editor changeLocation re-derives PDF paths for a project opened from a file', () => {
  beforeEach(async () => {
    destination = null
    await es().startEdit()
  })

  it('starts with the file\'s own relative paths', () => {
    expect(es().papers.map((p) => p.pdf)).toEqual(['pdfs/a.pdf', 'pdfs/sub/b.pdf'])
  })

  it('rebases every path when the project moves to a sibling directory', async () => {
    destination = { handle: { kind: 'electron', path: '/reviews/b/review.json' }, name: 'review.json' }
    await es().changeLocation()
    expect(es().papers.map((p) => p.pdf)).toEqual(['../a/pdfs/a.pdf', '../a/pdfs/sub/b.pdf'])
    expect(es().location?.handle.path).toBe('/reviews/b/review.json')
  })

  it('leaves the paths alone when the picker is cancelled', async () => {
    destination = null
    await es().changeLocation()
    expect(es().papers.map((p) => p.pdf)).toEqual(['pdfs/a.pdf', 'pdfs/sub/b.pdf'])
  })
})
