// [utest->req~dat-540~1]
// [utest->req~dat-550~1]
// [utest->req~dat-560~1]
// [utest->req~dat-570~1]
// [utest->req~ann-200~1]
// [utest->req~ann-210~1]
// [utest->req~lst-90~1]
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PdfFolderScan, SaveHandle } from '../platform/adapter'
import type { PdfMeta } from '../model/pdfMeta'

let scan: PdfFolderScan = { files: [], known: [] }
let meta: Record<string, PdfMeta> = {}

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  scanPdfFolder: vi.fn(async () => scan),
  getPdfSource: vi.fn(async (path: string) => ({ url: path })),
  fetchWeb: vi.fn(async () => ({ ok: true, status: 200, body: JSON.stringify({ message: { title: ['From Crossref'] } }) })),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))
vi.mock('../model/pdfMeta', () => ({ extractPdfMeta: async (bytes: ArrayBuffer) => meta[new TextDecoder().decode(bytes)] ?? {} }))
vi.stubGlobal('fetch', async (url: string) => ({ arrayBuffer: async () => new TextEncoder().encode(url).buffer }))

const { useStore } = await import('./store')

const handle: SaveHandle = { kind: 'electron', path: '/r/p.json' }
const st = () => useStore.getState()

function open(config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  st().setReadOnly(false)
  st().loadFromText(
    JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'A', type: 'string' }], pdfFolder: 'pdfs', ...config },
      papers: [
        { id: 'a', title: 'A', authors: [], pdf: 'pdfs/a.pdf', annotations: {} },
        { id: 'b', title: 'B', authors: [], pdf: 'pdfs/b.pdf', annotations: {} },
      ],
      ...extra,
    }),
    handle,
    'p.json',
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  meta = { 'pdfs/new.pdf': { title: 'New Paper', authors: ['Ada'], doi: '10.1/x' } }
  scan = {
    files: [
      { path: 'pdfs/a-renamed.pdf', sha256: 'ha' },
      { path: 'pdfs/new.pdf', sha256: 'hn' },
      { path: 'pdfs/other.pdf', sha256: 'ho' },
    ],
    known: ['ha', 'missing'],
  }
})

describe('scanPdfFolder', () => {
  it('matches files by hash, marks missing files and offers only new files', async () => {
    open()
    await st().scanPdfFolder()
    expect(mockPlatform.scanPdfFolder).toHaveBeenCalledWith('pdfs', ['pdfs/a.pdf', 'pdfs/b.pdf'], handle)
    expect(st().pdfProposals.map((p) => p.file.path)).toEqual(['pdfs/new.pdf', 'pdfs/other.pdf'])
    expect(st().pdfProposals[0].values).toEqual({ title: 'New Paper', authors: ['Ada'], doi: '10.1/x' })
    expect(st().pdfProposals[1].sources).toEqual({ title: 'filename' })
    expect(st().missingPdfs).toEqual(['b'])
    expect(st().pdfDialogOpen).toBe(true)
    expect(st().project!.papers).toHaveLength(2)
    expect(st().dirty).toBe(false)
  })

  it('sends nothing to Crossref while the setting is off', async () => {
    open()
    await st().scanPdfFolder()
    expect(mockPlatform.fetchWeb).not.toHaveBeenCalled()
  })

  it('asks Crossref for the DOI when the setting is on', async () => {
    open({ crossrefLookup: true })
    await st().scanPdfFolder()
    expect(mockPlatform.fetchWeb).toHaveBeenCalledWith('https://api.crossref.org/works/10.1%2Fx')
    expect(st().pdfProposals[0].values.title).toBe('From Crossref')
    expect(st().pdfProposals[0].sources.title).toBe('crossref')
  })

  it('does not open the dialog again on its own for files it offered before', async () => {
    open()
    await st().scanPdfFolder()
    st().setPdfDialogOpen(false)
    await st().scanPdfFolder()
    expect(st().pdfDialogOpen).toBe(false)
    expect(st().pdfProposals).toHaveLength(2)
    await st().scanPdfFolder(true)
    expect(st().pdfDialogOpen).toBe(true)
  })

  it('shows a readable error for a folder that does not exist', async () => {
    open()
    mockPlatform.scanPdfFolder.mockRejectedValueOnce(new Error('not-found'))
    await st().scanPdfFolder()
    expect(st().pdfScanError).toContain('pdfs')
    expect(st().pdfScanning).toBe(false)
  })

  it('does nothing without a PDF folder', async () => {
    open({ pdfFolder: undefined })
    await st().scanPdfFolder(true)
    expect(mockPlatform.scanPdfFolder).not.toHaveBeenCalled()
  })
})

describe('addPdfPapers', () => {
  it('adds confirmed papers once, in one undo step, and a second scan offers nothing', async () => {
    open()
    await st().scanPdfFolder()
    const proposals = st().pdfProposals
    expect(st().addPdfPapers(proposals)).toBe(2)
    expect(st().addPdfPapers(proposals)).toBe(0)
    const papers = st().project!.papers
    expect(papers.map((p) => p.id)).toEqual(['a', 'b', 'new', 'other'])
    expect(papers[2].extra).toMatchObject({ pdfSha256: 'hn', metadataSource: { title: 'pdfinfo' } })
    expect(st().pdfProposals).toEqual([])
    expect(st().dirty).toBe(true)
    await st().scanPdfFolder()
    expect(st().pdfProposals).toEqual([])
    expect(st().project!.papers).toHaveLength(4)
    st().undo()
    expect(st().project!.papers.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('keeps a skipped file for the next scan and drops an ignored file', async () => {
    open()
    await st().scanPdfFolder()
    expect(st().ignorePdfs(['ho'])).toBe(true)
    expect(st().project!.extra.ignoredPdfs).toEqual(['ho'])
    await st().scanPdfFolder()
    expect(st().pdfProposals.map((p) => p.file.sha256)).toEqual(['hn'])
  })

  it('writes nothing in view-only mode', async () => {
    open()
    await st().scanPdfFolder()
    st().setReadOnly(true)
    expect(st().addPdfPapers(st().pdfProposals)).toBe(0)
    expect(st().ignorePdfs(['hn'])).toBe(false)
    expect(st().project!.papers).toHaveLength(2)
  })
})
