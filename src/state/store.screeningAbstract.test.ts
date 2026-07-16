import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'

/**
 * `extractScreeningAbstract` reads a paper's PDF the same way `aiStore.ts`'s
 * `run()` does — `getPdfSource` → `fetch` → `arrayBuffer` → the pdfMeta
 * heuristic — so both are mocked here rather than exercised against a real
 * PDF. The heuristic itself is tested for real (against actual files on disk,
 * including a two-column paper) in `src/model/pdfMeta.test.ts`; these tests
 * are about the store's own orchestration: when it fires, the guards, the
 * dirty/undo bookkeeping, and the staleness check.
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

const ABSTRACT = 'The extracted abstract text, long enough to be plausible.'

function screeningProject(papers: unknown[]) {
  return JSON.stringify({
    version: 1,
    config: { screening: { reasons: ['Wrong topic'] } },
    papers,
  })
}

const paper = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Paper ${id}`,
  authors: [],
  pdf: `pdfs/${id}.pdf`,
  annotations: {},
  ...extra,
})

beforeEach(() => {
  extractPdfMetaMock = vi.fn(async () => ({ abstract: ABSTRACT }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
  )
})

describe('extraction fires on selection, not on opening the PDF', () => {
  it('extracts for the paper the project opens on, with no interaction at all', async () => {
    st().loadFromText(screeningProject([paper('p1'), paper('p2')]), null, 'test.json')
    await vi.waitFor(() => expect(st().project!.papers[0].abstract).toBe(ABSTRACT))
    expect(st().project!.papers[0].abstractFromPdf).toBe(true)
    // The PDF was never opened — the record view is what needed the abstract.
    expect(st().screeningShowPdf).toBe(false)
  })

  it('extracts when the reviewer selects a different paper', async () => {
    st().loadFromText(screeningProject([paper('p1'), paper('p2')]), null, 'test.json')
    await vi.waitFor(() => expect(st().project!.papers[0].abstract).toBe(ABSTRACT))

    st().selectPaper('p2')
    await vi.waitFor(() => expect(st().project!.papers[1].abstract).toBe(ABSTRACT))
    expect(st().project!.papers[1].abstractFromPdf).toBe(true)
  })

  it('extracts for the paper auto-advance lands on after a decision', async () => {
    // Auto-advance routes through selectPaper, so this must follow for free.
    st().loadFromText(screeningProject([paper('p1'), paper('p2')]), null, 'test.json')
    await vi.waitFor(() => expect(st().project!.papers[0].abstract).toBe(ABSTRACT))

    st().setScreeningDecision('Include') // p1 undecided -> decided, advances to p2
    expect(st().currentPaperId).toBe('p2')
    await vi.waitFor(() => expect(st().project!.papers[1].abstract).toBe(ABSTRACT))
  })

  it('does not fire merely because the PDF was toggled open', async () => {
    st().loadFromText(screeningProject([paper('p1', { abstract: 'Already here.' })]), null, 'test.json')
    extractPdfMetaMock.mockClear()
    st().toggleScreeningPdf()
    expect(st().screeningShowPdf).toBe(true)
    expect(extractPdfMetaMock).not.toHaveBeenCalled()
  })
})

describe('extractScreeningAbstract guards', () => {
  it('writes the extracted abstract and marks the project dirty', async () => {
    // The load itself already fires this for the opening paper, so wait for
    // that rather than calling again — a second call would (correctly) bail on
    // the in-flight marker and prove nothing.
    st().loadFromText(screeningProject([paper('p1')]), null, 'test.json')
    await vi.waitFor(() => expect(st().project!.papers[0].abstract).toBe(ABSTRACT))
    expect(st().project!.papers[0].abstractFromPdf).toBe(true)
    expect(st().dirty).toBe(true)
  })

  it('pushes no undo step — Ctrl+Z must undo the reviewer\'s decision, not a background fill', async () => {
    st().loadFromText(screeningProject([paper('p1'), paper('p2')]), null, 'test.json')
    await vi.waitFor(() => expect(st().project!.papers[0].abstract).toBe(ABSTRACT))
    expect(st().past).toHaveLength(0)

    st().setScreeningDecision('Include')
    expect(st().past).toHaveLength(1)
    st().undo()
    // The decision is undone; the abstract is untouched by it.
    expect(st().project!.papers[0].annotations.Decision[0].value).toBeNull()
    expect(st().project!.papers[0].abstract).toBe(ABSTRACT)
  })

  it('does nothing when the paper already has an abstract', async () => {
    st().loadFromText(screeningProject([paper('p1', { abstract: 'Already here.' })]), null, 'test.json')
    extractPdfMetaMock.mockClear()
    await st().extractScreeningAbstract('p1')
    expect(extractPdfMetaMock).not.toHaveBeenCalled()
    expect(st().project!.papers[0].abstract).toBe('Already here.')
    expect(st().project!.papers[0].abstractFromPdf).toBeUndefined()
    expect(st().dirty).toBe(false)
  })

  it('does nothing when the paper has no PDF', async () => {
    st().loadFromText(screeningProject([paper('p1', { pdf: '' })]), null, 'test.json')
    extractPdfMetaMock.mockClear()
    await st().extractScreeningAbstract('p1')
    expect(extractPdfMetaMock).not.toHaveBeenCalled()
    expect(st().dirty).toBe(false)
  })

  it('does nothing outside a screening project', async () => {
    st().loadFromText(
      JSON.stringify({
        version: 1,
        config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
        papers: [paper('p1')],
      }),
      null,
      'test.json',
    )
    extractPdfMetaMock.mockClear()
    await st().extractScreeningAbstract('p1')
    expect(extractPdfMetaMock).not.toHaveBeenCalled()
  })

  it('never writes anything when the heuristic finds no abstract', async () => {
    extractPdfMetaMock = vi.fn(async () => ({}))
    st().loadFromText(screeningProject([paper('p1')]), null, 'test.json')
    await st().extractScreeningAbstract('p1')
    expect(st().project!.papers[0].abstract).toBeUndefined()
    expect(st().dirty).toBe(false)
  })

  it('re-reads a PDF at most once per session when it yields no abstract', async () => {
    extractPdfMetaMock = vi.fn(async () => ({}))
    st().loadFromText(screeningProject([paper('p1'), paper('p2')]), null, 'test.json')
    await vi.waitFor(() => expect(st().screeningAbstractReads['p1']).toBe('none'))
    const callsAfterFirst = extractPdfMetaMock.mock.calls.length

    // Bouncing back and forth must not re-fetch and re-parse p1 every time.
    st().selectPaper('p2')
    st().selectPaper('p1')
    st().selectPaper('p1')
    await vi.waitFor(() => expect(st().screeningAbstractReads['p2']).toBe('none'))
    expect(extractPdfMetaMock.mock.calls.length).toBe(callsAfterFirst + 1) // p2 only
  })

  it('leaves no marker after a successful read, so an undone abstract can be re-extracted', async () => {
    st().loadFromText(screeningProject([paper('p1')]), null, 'test.json')
    await vi.waitFor(() => expect(st().project!.papers[0].abstract).toBe(ABSTRACT))
    expect(st().screeningAbstractReads['p1']).toBeUndefined()
  })

  it('does not clobber an abstract written some other way while the read was in flight', async () => {
    let resolveMeta!: (v: { abstract?: string }) => void
    extractPdfMetaMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveMeta = resolve
        }),
    )
    st().loadFromText(screeningProject([paper('p1')]), null, 'test.json')
    await vi.waitFor(() => expect(extractPdfMetaMock).toHaveBeenCalled())

    // The reviewer types a real abstract by hand while the PDF is still being read.
    useStore.setState((s) => {
      s.project!.papers[0].abstract = 'Typed by the reviewer.'
    })
    resolveMeta({ abstract: ABSTRACT })
    await vi.waitFor(() => expect(st().screeningAbstractReads['p1']).toBeUndefined())

    expect(st().project!.papers[0].abstract).toBe('Typed by the reviewer.')
    expect(st().project!.papers[0].abstractFromPdf).toBeUndefined()
  })

  it('survives the reviewer deciding a paper while the PDF is still being read', async () => {
    // The regression that motivated `projectGeneration`: immer hands back a new
    // `project` object on every edit, so a reference-equality staleness check
    // read an ordinary keystroke as "the project was replaced" and binned the
    // abstract — during screening, where a decision every second or two is the
    // entire point, that is the common case, not an edge one.
    let resolveMeta!: (v: { abstract?: string }) => void
    extractPdfMetaMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveMeta = resolve
        }),
    )
    st().loadFromText(screeningProject([paper('p1'), paper('p2')]), null, 'test.json')
    await vi.waitFor(() => expect(extractPdfMetaMock).toHaveBeenCalled())

    st().setScreeningDecision('Include') // a real edit — new project object
    resolveMeta({ abstract: ABSTRACT })

    await vi.waitFor(() => expect(st().project!.papers[0].abstract).toBe(ABSTRACT))
    expect(st().project!.papers[0].abstractFromPdf).toBe(true)
  })

  it('discards a result whose project has since been closed', async () => {
    let resolveMeta!: (v: { abstract?: string }) => void
    extractPdfMetaMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveMeta = resolve
        }),
    )
    st().loadFromText(screeningProject([paper('p1')]), null, 'test.json')
    await vi.waitFor(() => expect(extractPdfMetaMock).toHaveBeenCalled())

    st().closeProject()
    resolveMeta({ abstract: ABSTRACT })
    await vi.waitFor(() => expect(extractPdfMetaMock).toHaveBeenCalled())

    expect(st().project).toBeNull() // nothing written, nothing thrown
  })

  it('still writes a late result for a paper the reviewer has already moved on from', async () => {
    // The abstract belongs to that paper, not to the current selection —
    // discarding it because the reviewer scrolled on would just waste the read.
    let resolveMeta!: (v: { abstract?: string }) => void
    extractPdfMetaMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveMeta = resolve
        }),
    )
    st().loadFromText(screeningProject([paper('p1'), paper('p2')]), null, 'test.json')
    await vi.waitFor(() => expect(extractPdfMetaMock).toHaveBeenCalled())

    st().selectPaper('p2')
    resolveMeta({ abstract: ABSTRACT })
    await vi.waitFor(() => expect(st().project!.papers[0].abstract).toBe(ABSTRACT))
    expect(st().project!.papers[0].abstractFromPdf).toBe(true)
  })
})
