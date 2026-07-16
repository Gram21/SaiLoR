import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PickedPdf, ProjectLocation } from '../platform/adapter'

/**
 * Covers the two bulk-import paths added alongside `addPdfs` — a whole folder
 * of PDFs, and a BibTeX/RIS/CSL-JSON reference file — plus the "just added"
 * highlight both of them (and `addPdfs`) set. The platform is stubbed the same
 * way `editorStore.pdfs.test.ts` stubs it, so this only drives the store, not
 * a real file picker.
 */
let folderPicked: PickedPdf[] = []
let referencePicked: { text: string; name: string } | null = null

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  pickPdfs: async () => [],
  pickPdfFolder: async () => folderPicked,
  pickReferenceFile: async () => referencePicked,
  saveProject: async (_text: string, handle: unknown) => handle,
  relativePdfPaths: async (pdfs: PickedPdf[], location: ProjectLocation | null) => {
    const dir = location?.path?.replace(/\/[^/]+$/, '') ?? ''
    return pdfs.map((p) =>
      p.path && dir && p.path.startsWith(dir + '/') ? p.path.slice(dir.length + 1) : p.name,
    )
  },
}

vi.mock('../platform', () => ({
  getPlatform: () => mockPlatform,
}))

const { useEditorStore, findMatchingPaper, makePaperFromRef, makePaperFromPdf, makeNode } =
  await import('./editorStore')

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
    // A validateDraft-passing schema, needed by the "clears on save" tests below.
    nodes: [{ ...makeNode(), name: 'Relevant', kind: 'boolean' }],
    papers: [],
    dirty: false,
    notice: null,
    extracting: 0,
    justAdded: {},
  })
}

describe('addPdfFolder', () => {
  beforeEach(reset)

  it('adds every PDF the folder picker returns, same as addPdfs', async () => {
    folderPicked = [
      { name: 'a.pdf', path: '/reviews/pdfs/a.pdf' },
      { name: 'b.pdf', path: '/reviews/pdfs/b.pdf' },
    ]
    await useEditorStore.getState().addPdfFolder()
    const papers = useEditorStore.getState().papers
    expect(papers.map((p) => p.pdf)).toEqual(['pdfs/a.pdf', 'pdfs/b.pdf'])
  })

  it('shares the same duplicate-skipping logic as addPdfs (proof the two are the same code path)', async () => {
    folderPicked = [{ name: 'a.pdf', path: '/reviews/pdfs/a.pdf' }]
    await useEditorStore.getState().addPdfFolder()
    await useEditorStore.getState().addPdfFolder()
    expect(useEditorStore.getState().papers).toHaveLength(1)
    expect(useEditorStore.getState().notice).toMatch(/skipped: a\.pdf/i)
  })

  it('marks every newly added row as "just added"', async () => {
    folderPicked = [{ name: 'a.pdf', path: '/reviews/pdfs/a.pdf' }]
    await useEditorStore.getState().addPdfFolder()
    const [paper] = useEditorStore.getState().papers
    expect(useEditorStore.getState().justAdded[paper.uid]).toBe(true)
  })
})

describe('findMatchingPaper', () => {
  it('matches on DOI first, case-insensitively', () => {
    const papers = [
      makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set()),
      makePaperFromPdf('b.pdf', 'b.pdf', undefined, new Set()),
    ]
    papers[1].doi = '10.1000/XYZ'
    const match = findMatchingPaper(papers, { title: 'Some Other Title', authors: [], doi: '10.1000/xyz' })
    expect(match).toBe(papers[1])
  })

  it('falls back to a normalized-title match when there is no DOI hit', () => {
    const papers = [makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())]
    papers[0].title = 'A Study of Something: Really!'
    const match = findMatchingPaper(papers, {
      title: '  a study of something really  ',
      authors: [],
    })
    expect(match).toBe(papers[0])
  })

  it('does not match when neither DOI nor title line up', () => {
    const papers = [makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())]
    papers[0].title = 'Completely Different'
    expect(findMatchingPaper(papers, { title: 'Something Else', authors: [] })).toBeUndefined()
  })
})

describe('makePaperFromRef', () => {
  it('builds a row with an empty pdf when the entry has no file hint', () => {
    const paper = makePaperFromRef({ title: 'A New Paper', authors: ['Jane Doe'] }, new Set())
    expect(paper.title).toBe('A New Paper')
    expect(paper.authors).toBe('Jane Doe')
    expect(paper.pdf).toBe('')
    expect(paper.id).toBe('a-new-paper')
  })

  it('uses the file hint\'s base name as a pdf placeholder', () => {
    const paper = makePaperFromRef(
      { title: 'T', authors: [], pdfHint: 'C:\\papers\\doe2020.pdf' },
      new Set(),
    )
    expect(paper.pdf).toBe('doe2020.pdf')
  })
})

describe('importReferences', () => {
  beforeEach(reset)

  it('adds a new row per unmatched reference and marks it "just added"', async () => {
    referencePicked = {
      name: 'refs.json',
      text: JSON.stringify([
        { title: 'First Paper', author: [{ given: 'Jane', family: 'Doe' }] },
        { title: 'Second Paper' },
      ]),
    }
    await useEditorStore.getState().importReferences()
    const papers = useEditorStore.getState().papers
    expect(papers.map((p) => p.title)).toEqual(['First Paper', 'Second Paper'])
    expect(papers.every((p) => useEditorStore.getState().justAdded[p.uid])).toBe(true)
    expect(useEditorStore.getState().notice).toMatch(/Imported 2 references/i)
  })

  it('fills empty fields on a matching existing paper rather than adding a duplicate', async () => {
    const existing = makePaperFromPdf('doe.pdf', 'pdfs/doe.pdf', undefined, new Set())
    existing.title = 'A Study of Something'
    // authors/doi left blank, as if only the PDF was added so far.
    useEditorStore.setState({ papers: [existing] })

    referencePicked = {
      name: 'refs.json',
      text: JSON.stringify([
        {
          title: 'A Study of Something',
          author: [{ given: 'Jane', family: 'Doe' }],
          DOI: '10.1000/xyz',
        },
      ]),
    }
    await useEditorStore.getState().importReferences()

    const papers = useEditorStore.getState().papers
    expect(papers).toHaveLength(1) // no duplicate row
    expect(papers[0].authors).toBe('Jane Doe')
    expect(papers[0].doi).toBe('10.1000/xyz')
    // The matched row is an existing one, not a new addition.
    expect(useEditorStore.getState().justAdded[papers[0].uid]).toBeUndefined()
    expect(useEditorStore.getState().notice).toMatch(/1 updated existing paper/i)
  })

  it('never overwrites a field the reviewer already filled in', async () => {
    const existing = makePaperFromPdf('doe.pdf', 'pdfs/doe.pdf', undefined, new Set())
    existing.title = 'A Study of Something'
    existing.authors = 'Someone Else'
    useEditorStore.setState({ papers: [existing] })

    referencePicked = {
      name: 'refs.json',
      text: JSON.stringify([{ title: 'A Study of Something', author: [{ given: 'Jane', family: 'Doe' }] }]),
    }
    await useEditorStore.getState().importReferences()

    expect(useEditorStore.getState().papers[0].authors).toBe('Someone Else')
  })

  it('reports a match with nothing left to fill as "already complete"', async () => {
    const existing = makePaperFromPdf('doe.pdf', 'pdfs/doe.pdf', undefined, new Set())
    existing.title = 'A Study of Something'
    existing.authors = 'Jane Doe'
    existing.doi = '10.1000/xyz'
    useEditorStore.setState({ papers: [existing] })

    referencePicked = {
      name: 'refs.json',
      text: JSON.stringify([
        { title: 'A Study of Something', author: [{ given: 'Jane', family: 'Doe' }], DOI: '10.1000/xyz' },
      ]),
    }
    await useEditorStore.getState().importReferences()
    expect(useEditorStore.getState().notice).toMatch(/1 already complete/i)
  })

  it('sets a "no references found" notice instead of failing silently', async () => {
    referencePicked = { name: 'garbage.txt', text: 'not a reference file' }
    await useEditorStore.getState().importReferences()
    expect(useEditorStore.getState().papers).toHaveLength(0)
    expect(useEditorStore.getState().notice).toMatch(/no references could be read/i)
  })

  it('is a no-op when the file picker is cancelled', async () => {
    referencePicked = null
    const before = useEditorStore.getState().papers
    await useEditorStore.getState().importReferences()
    expect(useEditorStore.getState().papers).toBe(before)
  })

  it('is undoable as a single step', async () => {
    referencePicked = { name: 'refs.json', text: JSON.stringify([{ title: 'One' }, { title: 'Two' }]) }
    await useEditorStore.getState().importReferences()
    expect(useEditorStore.getState().papers).toHaveLength(2)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().papers).toHaveLength(0)
  })
})

describe('confirmAdded', () => {
  beforeEach(reset)

  it('drops the mark for that row only', async () => {
    folderPicked = [
      { name: 'a.pdf', path: '/reviews/pdfs/a.pdf' },
      { name: 'b.pdf', path: '/reviews/pdfs/b.pdf' },
    ]
    await useEditorStore.getState().addPdfFolder()
    const [a, b] = useEditorStore.getState().papers
    useEditorStore.getState().confirmAdded(a.uid)
    expect(useEditorStore.getState().justAdded[a.uid]).toBeUndefined()
    expect(useEditorStore.getState().justAdded[b.uid]).toBe(true)
  })

  it('is not itself an undo step (undo restores the mark, not just the data)', async () => {
    folderPicked = [{ name: 'a.pdf', path: '/reviews/pdfs/a.pdf' }]
    await useEditorStore.getState().addPdfFolder()
    const pastLength = useEditorStore.getState().past.length
    const [a] = useEditorStore.getState().papers
    useEditorStore.getState().confirmAdded(a.uid)
    expect(useEditorStore.getState().past).toHaveLength(pastLength)
  })
})

describe('"just added" marks are cleared on save/close, mirroring AI marks', () => {
  beforeEach(reset)

  it('clears on a successful save', async () => {
    folderPicked = [{ name: 'a.pdf', path: '/reviews/pdfs/a.pdf' }]
    await useEditorStore.getState().addPdfFolder()
    expect(Object.keys(useEditorStore.getState().justAdded)).toHaveLength(1)
    await useEditorStore.getState().save()
    expect(useEditorStore.getState().justAdded).toEqual({})
  })

  it('clears on close', async () => {
    folderPicked = [{ name: 'a.pdf', path: '/reviews/pdfs/a.pdf' }]
    await useEditorStore.getState().addPdfFolder()
    useEditorStore.getState().close()
    expect(useEditorStore.getState().justAdded).toEqual({})
  })
})
