import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ProjectLocation } from '../platform/adapter'

/**
 * The duplicate-review flow `importReferences` opens when `classifyImport`
 * finds a *probable* duplicate. Per the house rule, fixtures are real
 * BibTeX text run through the real `parseReferences` (never hand-built
 * `RefEntry`s — the platform mock only ever hands back raw text, exactly as
 * `editorStore.import.test.ts` already does), and an "existing project"
 * is built by running real JSON text through `editorStateFromOpened` — the
 * same parser `startEdit`/`startEditRecent` use — rather than assembling an
 * `EditorPaper[]` by hand.
 */
let referencePicked: { text: string; name: string } | null = null

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  pickPdfs: async () => [],
  pickPdfFolder: async () => [],
  pickReferenceFile: async () => referencePicked,
  saveProject: async (_text: string, handle: unknown) => handle,
  pickProjectLocation: async (name: string): Promise<ProjectLocation> => ({
    handle: { kind: 'electron', path: `/reviews/${name}` },
    name,
    path: `/reviews/${name}`,
  }),
}

vi.mock('../platform', () => ({
  getPlatform: () => mockPlatform,
}))

const { useEditorStore, editorStateFromOpened, makeNode } = await import('./editorStore')

const LOCATION: ProjectLocation = {
  handle: { kind: 'electron', path: '/reviews/my-slr.json' },
  name: 'my-slr.json',
  path: '/reviews/my-slr.json',
}

interface FixturePaper {
  id: string
  title: string
  authors: string[]
  doi?: string
  year?: number
}

/** A real editor session, built by running a real project JSON through the
 *  same `editorStateFromOpened` parser `startEdit` uses — not a hand-built
 *  `EditorPaper[]`. */
function openProjectWith(papers: FixturePaper[]): void {
  const text = JSON.stringify({
    version: 1,
    config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
    papers: papers.map((p) => ({
      id: p.id,
      title: p.title,
      authors: p.authors,
      ...(p.doi ? { doi: p.doi } : {}),
      ...(p.year !== undefined ? { year: p.year } : {}),
      pdf: `${p.id}.pdf`,
      annotations: {},
    })),
  })
  const state = editorStateFromOpened({ text, handle: LOCATION.handle, name: LOCATION.name })
  useEditorStore.setState({
    open: true,
    mode: 'edit',
    ...state,
    dirty: false,
    busy: false,
    error: null,
    issues: [],
    notice: null,
    extracting: 0,
    justAdded: {},
    past: [],
    future: [],
    screeningImport: null,
    duplicateReview: null,
  })
}

function reset() {
  useEditorStore.setState({
    open: true,
    mode: 'new',
    location: LOCATION,
    nodes: [{ ...makeNode(), name: 'Relevant', kind: 'boolean' }],
    papers: [],
    dirty: false,
    notice: null,
    extracting: 0,
    justAdded: {},
    duplicateReview: null,
    screeningImport: null,
    past: [],
    future: [],
  })
  referencePicked = null
}

describe('importReferences — no probable duplicates (regression guard)', () => {
  beforeEach(reset)

  it('commits immediately and never opens the review dialog, same as before this feature existed', async () => {
    referencePicked = {
      name: 'refs.bib',
      text: `
@article{a, title = {Quantum Computing Fundamentals}}
@article{b, title = {A History of Renaissance Art}}
`,
    }
    await useEditorStore.getState().importReferences()
    expect(useEditorStore.getState().duplicateReview).toBeNull()
    expect(useEditorStore.getState().papers.map((p) => p.title)).toEqual([
      'Quantum Computing Fundamentals',
      'A History of Renaissance Art',
    ])
    expect(useEditorStore.getState().notice).toMatch(/Imported 2 references/i)
  })
})

describe('importReferences — a probable duplicate opens the review dialog', () => {
  beforeEach(reset)

  it('commits nothing and leaves papers untouched until the reviewer decides', async () => {
    openProjectWith([{ id: 'p1', title: 'Continuous Integration Best Practices', authors: [] }])
    referencePicked = {
      name: 'refs.bib',
      text: `@article{a, title = {Continuous Integraton Best Practices}}`,
    }

    const papersBefore = useEditorStore.getState().papers
    await useEditorStore.getState().importReferences()

    const draft = useEditorStore.getState().duplicateReview
    expect(draft).not.toBeNull()
    expect(draft?.sourceName).toBe('refs.bib')
    expect(draft?.verdicts).toHaveLength(1)
    expect(draft?.verdicts[0].kind).toBe('probable')
    expect(useEditorStore.getState().papers).toBe(papersBefore) // untouched
  })

  it('detects a probable duplicate within the incoming batch itself', async () => {
    referencePicked = {
      name: 'refs.bib',
      text: `
@article{a, title = {Continuous Integration Best Practices}}
@article{b, title = {Continuous Integraton Best Practices}}
`,
    }
    await useEditorStore.getState().importReferences()
    const draft = useEditorStore.getState().duplicateReview
    expect(draft?.verdicts[0]).toEqual({ kind: 'new' })
    expect(draft?.verdicts[1].kind).toBe('probable')
    expect(draft?.verdicts[1].kind === 'probable' && draft.verdicts[1].target).toEqual({
      where: 'batch',
      index: 0,
    })
  })
})

describe("importReferences — an existing paper's own year takes part in the veto", () => {
  beforeEach(reset)

  // The point of wiring `EditorPaper.year` into `paperToDupRecord`: before it,
  // only the incoming reference carried a year, so a same-title pair years
  // apart could not be told apart against a project's own papers.
  it('a fuzzy-title match years apart from an existing paper is a fresh paper, not a duplicate', async () => {
    openProjectWith([
      { id: 'p1', title: 'Continuous Integration Best Practices', authors: [], year: 2015 },
    ])
    referencePicked = {
      name: 'refs.bib',
      text: `@article{a, title = {Continuous Integraton Best Practices}, year = {2022}}`,
    }
    await useEditorStore.getState().importReferences()
    // The year gap demotes the fuzzy title match to `new`, so it imports
    // straight through with no review dialog at all.
    expect(useEditorStore.getState().duplicateReview).toBeNull()
    expect(useEditorStore.getState().papers.map((p) => p.title)).toEqual([
      'Continuous Integration Best Practices',
      'Continuous Integraton Best Practices',
    ])
  })

  it('the same fuzzy-title match in the same year is still a probable duplicate', async () => {
    openProjectWith([
      { id: 'p1', title: 'Continuous Integration Best Practices', authors: [], year: 2015 },
    ])
    referencePicked = {
      name: 'refs.bib',
      text: `@article{a, title = {Continuous Integraton Best Practices}, year = {2015}}`,
    }
    await useEditorStore.getState().importReferences()
    expect(useEditorStore.getState().duplicateReview?.verdicts[0].kind).toBe('probable')
  })
})

describe('resolveDuplicateReview', () => {
  beforeEach(reset)

  it('"cancel" imports nothing at all and clears the draft', async () => {
    referencePicked = { name: 'refs.bib', text: `@article{a, title = {Continuous Integration Best Practices}}\n@article{b, title = {Continuous Integraton Best Practices}}` }
    await useEditorStore.getState().importReferences()
    expect(useEditorStore.getState().duplicateReview).not.toBeNull()

    useEditorStore.getState().resolveDuplicateReview('cancel')

    expect(useEditorStore.getState().duplicateReview).toBeNull()
    expect(useEditorStore.getState().papers).toHaveLength(0)
  })

  it('"apply" with a "merge" decision fills empty fields and never overwrites, adding no new row', async () => {
    openProjectWith([{ id: 'p1', title: 'Continuous Integration Best Practices', authors: ['Someone Else'] }])
    referencePicked = {
      name: 'refs.bib',
      text: `@article{a, title = {Continuous Integraton Best Practices}, doi = {10.1/ci}}`,
    }
    await useEditorStore.getState().importReferences()
    const draft = useEditorStore.getState().duplicateReview!
    expect(draft.verdicts[0].kind).toBe('probable')

    useEditorStore.getState().setDuplicateDecision(0, 'merge')
    useEditorStore.getState().resolveDuplicateReview('apply')

    const papers = useEditorStore.getState().papers
    expect(papers).toHaveLength(1) // no duplicate row
    expect(papers[0].doi).toBe('10.1/ci') // empty field filled
    expect(papers[0].authors).toBe('Someone Else') // populated field untouched
    expect(useEditorStore.getState().duplicateReview).toBeNull()
  })

  it('"apply" with a "separate" decision adds a new row with a de-duplicated id', async () => {
    openProjectWith([{ id: 'continuous-integration-best-practices', title: 'Continuous Integration Best Practices', authors: [] }])
    referencePicked = {
      name: 'refs.bib',
      text: `@article{a, title = {Continuous Integraton Best Practices}}`,
    }
    await useEditorStore.getState().importReferences()
    useEditorStore.getState().setDuplicateDecision(0, 'separate')
    useEditorStore.getState().resolveDuplicateReview('apply')

    const papers = useEditorStore.getState().papers
    expect(papers).toHaveLength(2)
    expect(papers[0].id).not.toBe(papers[1].id)
    expect(papers[1].title).toBe('Continuous Integraton Best Practices')
    expect(useEditorStore.getState().justAdded[papers[1].uid]).toBe(true)
  })

  it('a 3-entry chain resolves onto a single existing paper', async () => {
    // Entry 0 is a probable fuzzy match of the existing paper; entry 1 is an
    // exact-DOI (certain) match of entry 0. Deciding entry 0 "merge" must land
    // entry 1 on the *existing* paper too, not on a row that was never created.
    openProjectWith([{ id: 'p1', title: 'Continuous Integration Best Practices', authors: [] }])
    referencePicked = {
      name: 'refs.bib',
      text: `
@article{a, title = {Continuous Integraton Best Practices}, doi = {10.1/ci}}
@article{b, title = {Something Unrelated Entirely}, doi = {10.1/ci}}
`,
    }
    await useEditorStore.getState().importReferences()
    const draft = useEditorStore.getState().duplicateReview!
    expect(draft.verdicts[0].kind).toBe('probable')
    expect(draft.verdicts[1]).toEqual({
      kind: 'certain',
      target: { where: 'batch', index: 0 },
      reason: { via: 'doi' },
    })

    useEditorStore.getState().setDuplicateDecision(0, 'merge')
    useEditorStore.getState().resolveDuplicateReview('apply')

    const papers = useEditorStore.getState().papers
    expect(papers).toHaveLength(1) // both entries landed on the one existing paper
    expect(papers[0].doi).toBe('10.1/ci')
  })

  it('gives the reviewer control: leaving a probable entry undecided still lets the dialog stay open (store does not force a default)', async () => {
    openProjectWith([{ id: 'p1', title: 'Continuous Integration Best Practices', authors: [] }])
    referencePicked = { name: 'refs.bib', text: `@article{a, title = {Continuous Integraton Best Practices}}` }
    await useEditorStore.getState().importReferences()
    // No decision made — resolveDuplicateReview('apply') is a UI-gated action
    // (see DuplicateReviewDialog's `allDecided`), but the store itself does not
    // silently default an undecided probable row: it falls through commitImport's
    // "not shouldMerge" branch and is added as a new paper rather than merged.
    useEditorStore.getState().resolveDuplicateReview('apply')
    expect(useEditorStore.getState().papers).toHaveLength(2)
  })

  it('is a single undo step for the whole import', async () => {
    openProjectWith([{ id: 'p1', title: 'Continuous Integration Best Practices', authors: [] }])
    referencePicked = { name: 'refs.bib', text: `@article{a, title = {Continuous Integraton Best Practices}}` }
    await useEditorStore.getState().importReferences()
    useEditorStore.getState().setDuplicateDecision(0, 'separate')
    useEditorStore.getState().resolveDuplicateReview('apply')
    expect(useEditorStore.getState().papers).toHaveLength(2)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().papers).toHaveLength(1)
    expect(useEditorStore.getState().papers[0].title).toBe('Continuous Integration Best Practices')
  })
})

describe('setDuplicateDecision / setAllDuplicateDecisions', () => {
  beforeEach(reset)

  it('setAllDuplicateDecisions only touches probable rows', async () => {
    referencePicked = {
      name: 'refs.bib',
      text: `
@article{a, title = {Continuous Integration Best Practices}}
@article{b, title = {Continuous Integraton Best Practices}}
`,
    }
    await useEditorStore.getState().importReferences()
    useEditorStore.getState().setAllDuplicateDecisions('separate')
    const draft = useEditorStore.getState().duplicateReview!
    expect(draft.decisions).toEqual({ 1: 'separate' }) // entry 0 is 'new', never decided
  })

  it('setDuplicateDecision is a no-op for a non-probable row', async () => {
    referencePicked = {
      name: 'refs.bib',
      text: `
@article{a, title = {Continuous Integration Best Practices}}
@article{b, title = {Continuous Integraton Best Practices}}
`,
    }
    await useEditorStore.getState().importReferences()
    useEditorStore.getState().setDuplicateDecision(0, 'separate') // entry 0 is 'new'
    expect(useEditorStore.getState().duplicateReview?.decisions).toEqual({})
  })
})

describe('duplicateReview is cleared at the other three reset sites', () => {
  it('close()', async () => {
    reset()
    referencePicked = {
      name: 'refs.bib',
      text: `
@article{a, title = {Continuous Integration Best Practices}}
@article{b, title = {Continuous Integraton Best Practices}}
`,
    }
    await useEditorStore.getState().importReferences()
    expect(useEditorStore.getState().duplicateReview).not.toBeNull()
    useEditorStore.getState().close()
    expect(useEditorStore.getState().duplicateReview).toBeNull()
  })

  it('startNew()', async () => {
    reset()
    referencePicked = {
      name: 'refs.bib',
      text: `
@article{a, title = {Continuous Integration Best Practices}}
@article{b, title = {Continuous Integraton Best Practices}}
`,
    }
    await useEditorStore.getState().importReferences()
    expect(useEditorStore.getState().duplicateReview).not.toBeNull()
    await useEditorStore.getState().startNew()
    expect(useEditorStore.getState().duplicateReview).toBeNull()
  })
})
