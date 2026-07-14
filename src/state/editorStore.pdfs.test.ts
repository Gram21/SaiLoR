import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PickedPdf, ProjectLocation } from '../platform/adapter'

/**
 * Adding PDFs goes through the platform (native/browser pickers), so the
 * adapter is stubbed here to drive `addPdfs` directly. The PDFs carry no
 * `read`, so no metadata extraction runs — that logic is covered by
 * `src/model/pdfMeta.test.ts`.
 */
let picked: PickedPdf[] = []

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  // loadFromText records the open project as a recent once it knows its title.
  rememberProject: () => {},
  forgetRecent: () => [],
  getOsInfo: () => null,
  pickPdfs: async () => picked,
  // Mirrors the Electron adapter: paths relative to the JSON's directory.
  relativePdfPaths: async (pdfs: PickedPdf[], location: ProjectLocation | null) => {
    const dir = location?.path?.replace(/\/[^/]+$/, '') ?? ''
    return pdfs.map((p) => (p.path && dir && p.path.startsWith(dir + '/')
      ? p.path.slice(dir.length + 1)
      : p.name))
  },
}

vi.mock('../platform', () => ({
  getPlatform: () => mockPlatform,
}))

const { useEditorStore, pdfKeys, makePaperFromPdf } = await import('./editorStore')

const LOCATION: ProjectLocation = {
  handle: { kind: 'electron', path: '/reviews/my-slr.json' },
  name: 'my-slr.json',
  path: '/reviews/my-slr.json',
}

function reset() {
  useEditorStore.setState({
    open: true,
    mode: 'new',
    location: LOCATION,
    nodes: [],
    papers: [],
    dirty: false,
    notice: null,
    extracting: 0,
  })
}

describe('pdfKeys', () => {
  it('identifies a PDF by its absolute path and its stored relative path', () => {
    expect(pdfKeys({ pdf: 'pdfs/a.pdf', sourcePath: '/reviews/pdfs/a.pdf' })).toEqual([
      '/reviews/pdfs/a.pdf',
      'pdfs/a.pdf',
    ])
    // A paper loaded from an existing file has no absolute source.
    expect(pdfKeys({ pdf: 'pdfs/a.pdf' })).toEqual(['pdfs/a.pdf'])
  })
})

describe('addPdfs deduplication', () => {
  beforeEach(reset)

  it('adds new PDFs and derives their path relative to the JSON', async () => {
    picked = [
      { name: 'a.pdf', path: '/reviews/pdfs/a.pdf' },
      { name: 'b.pdf', path: '/reviews/pdfs/b.pdf' },
    ]
    await useEditorStore.getState().addPdfs()
    const papers = useEditorStore.getState().papers
    expect(papers.map((p) => p.pdf)).toEqual(['pdfs/a.pdf', 'pdfs/b.pdf'])
    expect(useEditorStore.getState().notice).toBeNull()
  })

  it('skips a PDF already in the project (same absolute path)', async () => {
    picked = [{ name: 'a.pdf', path: '/reviews/pdfs/a.pdf' }]
    await useEditorStore.getState().addPdfs()
    // Pick the very same file again, plus a new one.
    picked = [
      { name: 'a.pdf', path: '/reviews/pdfs/a.pdf' },
      { name: 'c.pdf', path: '/reviews/pdfs/c.pdf' },
    ]
    await useEditorStore.getState().addPdfs()

    const papers = useEditorStore.getState().papers
    expect(papers.map((p) => p.pdf)).toEqual(['pdfs/a.pdf', 'pdfs/c.pdf'])
    expect(useEditorStore.getState().notice).toMatch(/skipped: a\.pdf/i)
  })

  it('skips a duplicate selected twice within one pick', async () => {
    picked = [
      { name: 'a.pdf', path: '/reviews/pdfs/a.pdf' },
      { name: 'a.pdf', path: '/reviews/pdfs/a.pdf' },
    ]
    await useEditorStore.getState().addPdfs()
    expect(useEditorStore.getState().papers).toHaveLength(1)
  })

  it('matches on the relative path for papers loaded from an existing file', async () => {
    // As if the project was opened for editing: a paper with no absolute source.
    useEditorStore.setState({
      papers: [makePaperFromPdf('a.pdf', 'pdfs/a.pdf', undefined, new Set())],
    })
    picked = [{ name: 'a.pdf', path: '/reviews/pdfs/a.pdf' }]
    await useEditorStore.getState().addPdfs()

    expect(useEditorStore.getState().papers).toHaveLength(1)
    expect(useEditorStore.getState().notice).toMatch(/skipped: a\.pdf/i)
  })

  it('treats same-named PDFs in different folders as distinct', async () => {
    picked = [
      { name: 'a.pdf', path: '/reviews/pdfs/2023/a.pdf' },
      { name: 'a.pdf', path: '/reviews/pdfs/2024/a.pdf' },
    ]
    await useEditorStore.getState().addPdfs()
    const papers = useEditorStore.getState().papers
    expect(papers.map((p) => p.pdf)).toEqual(['pdfs/2023/a.pdf', 'pdfs/2024/a.pdf'])
    // Their ids must not collide either.
    expect(papers[0].id).not.toBe(papers[1].id)
  })
})
