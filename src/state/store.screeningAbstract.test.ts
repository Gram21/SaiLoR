import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'

/**
 * `extractScreeningAbstract` reads a paper's PDF the same way `aiStore.ts`'s
 * `run()` does — `getPdfSource` → `fetch` → `arrayBuffer` → the pdfMeta
 * heuristic — so both are mocked here rather than exercised against a real
 * PDF: `pdfMeta.ts`'s own heuristic is unit-tested directly in
 * `pdfMeta.test.ts` against synthetic page lines, and there is nothing
 * store-specific to gain by re-parsing a real file through pdf.js in this
 * environment. These tests are about the store's own orchestration — the
 * guards, the dirty/undo bookkeeping, and the staleness check — not the text
 * extraction itself.
 */

let extractPdfMetaMock = vi.fn(async () => ({}) as { abstract?: string })

vi.mock('../model/pdfMeta', () => ({
  extractPdfMeta: () => extractPdfMetaMock(),
}))

const mockPlatform = {
  kind: 'browser' as const,
  getOsInfo: () => null,
  getRecents: () => [] as RecentEntry[],
  rememberProject: () => {},
  forgetRecent: () => [] as RecentEntry[],
  checkRecents: async (entries: RecentEntry[]) => entries,
  openProject: async () => null,
  openRecent: async () => null,
  saveProject: async (_text: string, handle: SaveHandle) => handle,
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: 'blob:fake-pdf' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')

const st = () => useStore.getState()

function screeningProject(papers: unknown[]) {
  return JSON.stringify({
    version: 1,
    config: { screening: { reasons: ['Wrong topic'] } },
    papers,
  })
}

const withPdfNoAbstract = [
  { id: 'p1', title: 'Paper One', authors: [], pdf: 'pdfs/p1.pdf', annotations: {} },
]
const withPdfAndAbstract = [
  {
    id: 'p1',
    title: 'Paper One',
    authors: [],
    pdf: 'pdfs/p1.pdf',
    abstract: 'Already has one.',
    annotations: {},
  },
]
const noPdf = [{ id: 'p1', title: 'Paper One', authors: [], pdf: '', annotations: {} }]

beforeEach(() => {
  extractPdfMetaMock = vi.fn(async () => ({ abstract: 'The extracted abstract text, long enough.' }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
  )
})

describe('toggleScreeningPdf', () => {
  it('fires extraction when opening the PDF on a paper with none yet', async () => {
    st().loadFromText(screeningProject(withPdfNoAbstract), null, 'test.json')
    st().selectPaper('p1')
    st().toggleScreeningPdf()
    expect(st().screeningShowPdf).toBe(true) // the toggle itself is synchronous
    await vi.waitFor(() => expect(st().project!.papers[0].abstract).toBe('The extracted abstract text, long enough.'))
    expect(st().project!.papers[0].abstractFromPdf).toBe(true)
  })

  it('does not fire extraction when closing the PDF', async () => {
    st().loadFromText(screeningProject(withPdfNoAbstract), null, 'test.json')
    st().selectPaper('p1')
    st().toggleScreeningPdf() // open — fires
    await vi.waitFor(() => expect(st().project!.papers[0].abstract).toBeTruthy())
    extractPdfMetaMock.mockClear()
    st().toggleScreeningPdf() // close — must not fire again
    expect(st().screeningShowPdf).toBe(false)
    expect(extractPdfMetaMock).not.toHaveBeenCalled()
  })
})

describe('extractScreeningAbstract', () => {
  it('writes the extracted abstract and flags it, as one undo step', async () => {
    st().loadFromText(screeningProject(withPdfNoAbstract), null, 'test.json')
    st().selectPaper('p1')
    const before = st().past.length
    await st().extractScreeningAbstract()
    expect(st().project!.papers[0].abstract).toBe('The extracted abstract text, long enough.')
    expect(st().project!.papers[0].abstractFromPdf).toBe(true)
    expect(st().dirty).toBe(true)
    expect(st().past.length).toBe(before + 1)
    st().undo()
    expect(st().project!.papers[0].abstract).toBeUndefined()
  })

  it('does nothing when the paper already has an abstract', async () => {
    st().loadFromText(screeningProject(withPdfAndAbstract), null, 'test.json')
    st().selectPaper('p1')
    await st().extractScreeningAbstract()
    expect(extractPdfMetaMock).not.toHaveBeenCalled()
    expect(st().project!.papers[0].abstract).toBe('Already has one.')
    expect(st().project!.papers[0].abstractFromPdf).toBeUndefined()
    expect(st().dirty).toBe(false)
  })

  it('does nothing when the paper has no PDF', async () => {
    st().loadFromText(screeningProject(noPdf), null, 'test.json')
    st().selectPaper('p1')
    await st().extractScreeningAbstract()
    expect(extractPdfMetaMock).not.toHaveBeenCalled()
    expect(st().dirty).toBe(false)
  })

  it('does nothing outside a screening project', async () => {
    st().loadFromText(
      JSON.stringify({
        version: 1,
        config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
        papers: withPdfNoAbstract,
      }),
      null,
      'test.json',
    )
    st().selectPaper('p1')
    await st().extractScreeningAbstract()
    expect(extractPdfMetaMock).not.toHaveBeenCalled()
  })

  it('never writes anything when the heuristic finds no abstract', async () => {
    extractPdfMetaMock = vi.fn(async () => ({}))
    st().loadFromText(screeningProject(withPdfNoAbstract), null, 'test.json')
    st().selectPaper('p1')
    await st().extractScreeningAbstract()
    expect(st().project!.papers[0].abstract).toBeUndefined()
    expect(st().dirty).toBe(false)
  })

  it('does not clobber an abstract written some other way while the read was in flight', async () => {
    let resolveMeta!: (v: { abstract?: string }) => void
    extractPdfMetaMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveMeta = resolve
        }),
    )
    st().loadFromText(screeningProject(withPdfNoAbstract), null, 'test.json')
    st().selectPaper('p1')
    const pending = st().extractScreeningAbstract()

    // Let the pending promise chain actually reach the mocked extractPdfMeta
    // call (it awaits getPdfSource + fetch + arrayBuffer first) before the
    // reviewer's hand-typed edit and the heuristic's own resolution race.
    await vi.waitFor(() => expect(extractPdfMetaMock).toHaveBeenCalled())

    // The reviewer types a real abstract by hand while the PDF is still being read.
    useStore.setState((s) => {
      s.project!.papers[0].abstract = 'Typed by the reviewer.'
    })

    resolveMeta({ abstract: 'From the PDF, arriving late.' })
    await pending

    expect(st().project!.papers[0].abstract).toBe('Typed by the reviewer.')
    expect(st().project!.papers[0].abstractFromPdf).toBeUndefined()
  })
})
