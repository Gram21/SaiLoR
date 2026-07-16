import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PickedPdf, ProjectLocation } from '../platform/adapter'

/**
 * Adding PDFs goes through the platform (native/browser pickers), so the
 * adapter is stubbed here to drive `addPdfs` directly. Most PDFs below carry
 * no `read`, so no metadata extraction runs for them — the heuristic itself
 * is covered by `src/model/pdfMeta.test.ts`. The "abstract extraction"
 * describe block near the bottom is the exception: it mocks `extractPdfMeta`
 * directly (rather than driving a real PDF through pdf.js) to test the
 * store's own wiring — does it write `abstract`/`abstractFromPdf`, and does
 * it leave an existing abstract alone.
 */
let picked: PickedPdf[] = []
let extractPdfMetaMock = vi.fn(async () => ({}) as { title?: string; authors?: string[]; abstract?: string })

vi.mock('../model/pdfMeta', () => ({
  extractPdfMeta: () => extractPdfMetaMock(),
}))

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  // loadFromText records the open project as a recent once it knows its title.
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
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
  extractPdfMetaMock = vi.fn(async () => ({}))
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

describe('addPdfs abstract extraction', () => {
  beforeEach(reset)

  const readable = (name: string, path: string): PickedPdf => ({
    name,
    path,
    read: async () => new ArrayBuffer(0),
  })

  it('pre-fills the abstract and flags it as PDF-extracted', async () => {
    extractPdfMetaMock = vi.fn(async () => ({ abstract: 'An abstract read from the PDF.' }))
    picked = [readable('a.pdf', '/reviews/pdfs/a.pdf')]
    await useEditorStore.getState().addPdfs()
    const [paper] = useEditorStore.getState().papers
    expect(paper.abstract).toBe('An abstract read from the PDF.')
    expect(paper.abstractFromPdf).toBe(true)
  })

  it('does not flag a row when the heuristic finds nothing', async () => {
    extractPdfMetaMock = vi.fn(async () => ({}))
    picked = [readable('a.pdf', '/reviews/pdfs/a.pdf')]
    await useEditorStore.getState().addPdfs()
    const [paper] = useEditorStore.getState().papers
    expect(paper.abstract).toBe('')
    expect(paper.abstractFromPdf).toBeUndefined()
  })

  it('never overwrites an abstract the reviewer already typed while the read was in flight', async () => {
    let resolveMeta!: (v: { abstract?: string }) => void
    extractPdfMetaMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveMeta = resolve
        }),
    )
    picked = [readable('a.pdf', '/reviews/pdfs/a.pdf')]
    const pending = useEditorStore.getState().addPdfs()
    await vi.waitFor(() => expect(useEditorStore.getState().papers).toHaveLength(1))

    useEditorStore.setState((s) => {
      s.papers[0].abstract = 'Typed by the reviewer.'
    })
    resolveMeta({ abstract: 'From the PDF, arriving late.' })
    await pending

    const [paper] = useEditorStore.getState().papers
    expect(paper.abstract).toBe('Typed by the reviewer.')
    expect(paper.abstractFromPdf).toBeUndefined()
  })
})
