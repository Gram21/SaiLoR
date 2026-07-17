import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { OpenedProject, ProjectLocation, SaveHandle } from '../platform/adapter'
import { screeningStatus } from '../screening/status'

let openResult: OpenedProject | null = null
let siblingResult: ProjectLocation | null = null
let pickResult: ProjectLocation | null = null
/** What `resolveScreeningImport` actually suggested — the only way to see the
 *  filename it picked, since `siblingResult` above is a fixed stub return. */
let siblingSuggested: string | null = null
/** What `relativePdfPaths` should hand back — set per test to a value
 *  distinguishable from both the verbatim source `pdf` and the absolute
 *  source path, so a test can tell whether the rebase actually happened and
 *  its result actually landed on the row. */
let relativeResult: string[] = []
let relativeCalls: { pdfs: { name: string; path?: string }[]; location: ProjectLocation | null }[] = []

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  openProject: async () => openResult,
  pickProjectLocation: async () => pickResult,
  siblingProjectLocation: async (_handle: SaveHandle, suggested: string) => {
    siblingSuggested = suggested
    return siblingResult
  },
  absolutePdfPaths: async (paths: string[]) => paths.map((p) => (p ? `/abs/${p}` : undefined)),
  relativePdfPaths: async (pdfs: { name: string; path?: string }[], location: ProjectLocation | null) => {
    relativeCalls.push({ pdfs, location })
    return relativeResult
  },
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore, buildProjectJson, validateDraft, makeNode, editorStateFromOpened } = await import(
  './editorStore'
)
const { loadProject } = await import('../model/project')

function draft(overrides: Partial<Parameters<typeof buildProjectJson>[0]> = {}) {
  return {
    version: 1,
    aiEnabled: true,
    reviewers: 1,
    extra: {},
    nodes: [],
    papers: [],
    screening: { reasons: ['Wrong topic', 'Duplicate'] },
    ...overrides,
  }
}

function reset() {
  useEditorStore.setState({
    open: false,
    mode: 'new',
    location: null,
    nodes: [makeNode()],
    papers: [],
    screening: null,
    provenance: null,
    protocol: null,
    dirty: false,
    notice: null,
    error: null,
    extracting: 0,
    justAdded: {},
    past: [],
    future: [],
    screeningImport: null,
  })
  openResult = null
  siblingResult = null
  pickResult = null
  siblingSuggested = null
  relativeResult = []
  relativeCalls = []
}

beforeEach(reset)

describe('buildProjectJson with screening', () => {
  it('writes the derived config.schema and config.screening, and the result loads', () => {
    const json = buildProjectJson(draft())
    const config = json.config as Record<string, unknown>
    expect(config.screening).toEqual({ reasons: ['Wrong topic', 'Duplicate'] })
    expect((config.schema as Array<{ name: string }>).map((d) => d.name)).toEqual(['Decision', 'Reason'])

    const project = loadProject(JSON.stringify(json))
    expect(project.screening).toEqual({ reasons: ['Wrong topic', 'Duplicate'] })
    expect(project.schema.map((d) => d.name)).toEqual(['Decision', 'Reason'])
  })
})

describe('validateDraft with screening', () => {
  it('accepts a screening draft with no authored nodes and no PDFs', () => {
    const issues = validateDraft(
      draft({
        papers: [
          {
            uid: 'u1',
            id: 'p1',
            title: 'Paper',
            authors: '',
            doi: '',
            year: '',
            venue: '',
            abstract: '',
            pdf: '',
            annotations: {},
          },
        ],
      }),
    )
    expect(issues).toEqual([])
  })

  it('rejects a screening draft with no exclusion reasons', () => {
    const issues = validateDraft(draft({ screening: { reasons: [] } }))
    expect(issues.join(' ')).toMatch(/at least one exclusion reason/i)
  })

  it('still rejects a non-screening paper with no PDF', () => {
    const issues = validateDraft(
      draft({
        screening: null,
        nodes: [{ ...makeNode(), name: 'X', kind: 'string' }],
        papers: [
          {
            uid: 'u1',
            id: 'p1',
            title: 'Paper',
            authors: '',
            doi: '',
            year: '',
            venue: '',
            abstract: '',
            pdf: '',
            annotations: {},
          },
        ],
      }),
    )
    expect(issues).toEqual(['Paper 1 has no PDF attached.'])
  })
})

describe('startFromScreening / resolveScreeningImport', () => {
  function screeningJson(papers: unknown[]) {
    return JSON.stringify({
      version: 1,
      config: { screening: { reasons: ['Wrong topic', 'Duplicate'] } },
      papers,
    })
  }

  const SOURCE_HANDLE: SaveHandle = { kind: 'electron', path: '/reviews/screening.json' }

  beforeEach(() => {
    openResult = {
      text: screeningJson([
        { id: 'inc', title: 'Included', authors: ['A'], doi: 'd1', abstract: 'abs1', pdf: 'inc.pdf', annotations: { Decision: [{ value: 'Include' }] } },
        { id: 'exc', title: 'Excluded', authors: [], pdf: '', annotations: { Decision: [{ value: 'Exclude' }], Reason: [{ value: 'Duplicate' }] } },
        { id: 'und', title: 'Undecided', authors: [], pdf: '', annotations: {} },
        { id: 'weird', title: 'Weird decision', authors: [], pdf: '', annotations: { Decision: [{ value: 'Maybe' }] } },
      ]),
      handle: SOURCE_HANDLE,
      name: 'screening.json',
    }
    siblingResult = {
      handle: { kind: 'electron', path: '/reviews/screening-annotation.json' },
      name: 'screening-annotation.json',
      path: '/reviews/screening-annotation.json',
    }
  })

  it('partitions included / excluded / undecided, and a hand-edited unknown decision is treated as undecided', async () => {
    await useEditorStore.getState().startFromScreening()
    const draftImport = useEditorStore.getState().screeningImport!
    expect(draftImport.included.map((p) => p.id)).toEqual(['inc'])
    expect(draftImport.excludedCount).toBe(1)
    expect(draftImport.excludedByReason).toEqual({ Duplicate: 1 })
    // "weird" carries an unrecognised decision, and rides along with "und" —
    // never silently dropped as if it had been excluded.
    expect(draftImport.undecided.map((p) => p.id).sort()).toEqual(['und', 'weird'])
    // Defaults to annotation: a silent change of what the existing button
    // produces would undermine the reason this dialog exists at all.
    expect(draftImport.startKind).toBe('annotation')
  })

  it('include-undecided: carries included + undecided, keeps metadata, drops reviews/equal/aiUsage', async () => {
    await useEditorStore.getState().startFromScreening()
    await useEditorStore.getState().resolveScreeningImport('include-undecided')

    const st = useEditorStore.getState()
    expect(st.open).toBe(true)
    expect(st.mode).toBe('new')
    expect(st.screening).toBeNull() // the new project is an annotation project, not screening
    const ids = st.papers.map((p) => p.id).sort()
    expect(ids).toEqual(['inc', 'und', 'weird'])

    const inc = st.papers.find((p) => p.id === 'inc')!
    expect(inc.title).toBe('Included')
    expect(inc.authors).toBe('A')
    expect(inc.doi).toBe('d1')
    expect(inc.abstract).toBe('abs1')
    expect(inc.pdf).toBe('inc.pdf')
    expect(inc.annotations).toEqual({})
    expect((inc as unknown as { reviews?: unknown }).reviews).toBeUndefined()
    expect((inc as unknown as { equal?: unknown }).equal).toBeUndefined()
    expect((inc as unknown as { aiUsage?: unknown }).aiUsage).toBeUndefined()
  })

  it('skip-undecided: excludes the undecided papers too', async () => {
    await useEditorStore.getState().startFromScreening()
    await useEditorStore.getState().resolveScreeningImport('skip-undecided')
    const ids = useEditorStore.getState().papers.map((p) => p.id).sort()
    expect(ids).toEqual(['inc'])
  })

  it('cancel leaves the editor closed and clears the pending import', async () => {
    await useEditorStore.getState().startFromScreening()
    await useEditorStore.getState().resolveScreeningImport('cancel')
    expect(useEditorStore.getState().open).toBe(false)
    expect(useEditorStore.getState().screeningImport).toBeNull()
  })

  it('never touches a project the source is not a screening project', async () => {
    openResult = { text: JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'X', type: 'string' }] },
      papers: [],
    }), handle: SOURCE_HANDLE, name: 'annotation.json' }
    await useEditorStore.getState().startFromScreening()
    expect(useEditorStore.getState().error?.message).toMatch(/not a screening project/i)
    expect(useEditorStore.getState().screeningImport).toBeNull()
  })

  it('setScreeningImportKind("screening") makes resolve build a screening project seeded from the source reasons', async () => {
    await useEditorStore.getState().startFromScreening()
    useEditorStore.getState().setScreeningImportKind('screening')
    expect(useEditorStore.getState().screeningImport?.startKind).toBe('screening')
    await useEditorStore.getState().resolveScreeningImport('include-undecided')

    const st = useEditorStore.getState()
    expect(st.screening).toEqual({ reasons: ['Wrong topic', 'Duplicate'] })
    // Seeded from the source's own reasons, not the generic defaults — the
    // source's list is the pre-registered protocol's own vocabulary.
    expect(st.screening?.reasons).not.toEqual(expect.arrayContaining(['Not peer-reviewed']))
    expect(st.nodes).toEqual([])
    expect(st.mode).toBe('new')
  })

  it('setScreeningImportKind is a no-op with no pending import', () => {
    useEditorStore.getState().setScreeningImportKind('screening')
    expect(useEditorStore.getState().screeningImport).toBeNull()
  })

  it('suggests an "-annotation" filename for the annotation target and "-fulltext" for the screening target', async () => {
    await useEditorStore.getState().startFromScreening()
    await useEditorStore.getState().resolveScreeningImport('include-undecided')
    expect(siblingSuggested).toBe('screening-annotation.json')

    reset()
    openResult = {
      text: screeningJson([
        { id: 'inc', title: 'Included', authors: [], pdf: '', annotations: { Decision: [{ value: 'Include' }] } },
      ]),
      handle: SOURCE_HANDLE,
      name: 'screening.json',
    }
    siblingResult = {
      handle: { kind: 'electron', path: '/reviews/screening-fulltext.json' },
      name: 'screening-fulltext.json',
      path: '/reviews/screening-fulltext.json',
    }
    await useEditorStore.getState().startFromScreening()
    useEditorStore.getState().setScreeningImportKind('screening')
    await useEditorStore.getState().resolveScreeningImport('include-undecided')
    expect(siblingSuggested).toBe('screening-fulltext.json')
  })

  it('inherits the source reviewer count for a screening target, but not for the annotation target', async () => {
    openResult = {
      text: JSON.stringify({
        version: 1,
        config: { screening: { reasons: ['Wrong topic', 'Duplicate'] }, reviewers: 3 },
        papers: [
          { id: 'inc', title: 'Included', authors: [], pdf: '', annotations: { Decision: [{ value: 'Include' }] } },
        ],
      }),
      handle: SOURCE_HANDLE,
      name: 'screening.json',
    }
    await useEditorStore.getState().startFromScreening()
    useEditorStore.getState().setScreeningImportKind('screening')
    await useEditorStore.getState().resolveScreeningImport('include-undecided')
    expect(useEditorStore.getState().reviewers).toBe(3)

    reset()
    openResult = {
      text: JSON.stringify({
        version: 1,
        config: { screening: { reasons: ['Wrong topic', 'Duplicate'] }, reviewers: 3 },
        papers: [
          { id: 'inc', title: 'Included', authors: [], pdf: '', annotations: { Decision: [{ value: 'Include' }] } },
        ],
      }),
      handle: SOURCE_HANDLE,
      name: 'screening.json',
    }
    siblingResult = {
      handle: { kind: 'electron', path: '/reviews/screening-annotation.json' },
      name: 'screening-annotation.json',
      path: '/reviews/screening-annotation.json',
    }
    await useEditorStore.getState().startFromScreening()
    // startKind stays 'annotation' (the default) — the seat count is not inherited.
    await useEditorStore.getState().resolveScreeningImport('include-undecided')
    expect(useEditorStore.getState().reviewers).toBe(1)
  })

  it('drops first-pass decisions for the screening target too — a full-text decision is not anchored by the title/abstract one', async () => {
    await useEditorStore.getState().startFromScreening()
    useEditorStore.getState().setScreeningImportKind('screening')
    await useEditorStore.getState().resolveScreeningImport('include-undecided')
    const inc = useEditorStore.getState().papers.find((p) => p.id === 'inc')!
    expect(inc.annotations).toEqual({})
  })

  it('skip-undecided records the full census, not just what was carried', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T12:00:00.000Z'))
    try {
      await useEditorStore.getState().startFromScreening()
      await useEditorStore.getState().resolveScreeningImport('skip-undecided')
      expect(useEditorStore.getState().provenance).toEqual({
        kind: 'screening-import',
        source: { file: 'screening.json' },
        importedAt: '2026-07-17T12:00:00.000Z',
        counts: { included: 1, undecided: 2, excluded: 1, carried: 1 },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('records provenance: source, timestamp, and the full carried/dropped census', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T12:00:00.000Z'))
    try {
      await useEditorStore.getState().startFromScreening()
      await useEditorStore.getState().resolveScreeningImport('include-undecided')
      expect(useEditorStore.getState().provenance).toEqual({
        kind: 'screening-import',
        source: { file: 'screening.json' },
        importedAt: '2026-07-17T12:00:00.000Z',
        counts: { included: 1, undecided: 2, excluded: 1, carried: 3 },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('the "weird" (unrecognised decision) paper counts toward undecided/carried, never silently dropped', async () => {
    await useEditorStore.getState().startFromScreening()
    await useEditorStore.getState().resolveScreeningImport('include-undecided')
    expect(useEditorStore.getState().provenance?.counts).toEqual({
      included: 1,
      undecided: 2,
      excluded: 1,
      carried: 3,
    })
    expect(useEditorStore.getState().papers.map((p) => p.id).sort()).toEqual(['inc', 'und', 'weird'])
  })

  it('round-trips end to end: resolve -> buildProjectJson -> loadProject', async () => {
    await useEditorStore.getState().startFromScreening()
    useEditorStore.getState().setScreeningImportKind('screening')
    await useEditorStore.getState().resolveScreeningImport('include-undecided')

    const json = buildProjectJson(useEditorStore.getState())
    const project = loadProject(JSON.stringify(json))
    expect(project.screening).toEqual({ reasons: ['Wrong topic', 'Duplicate'] })
    expect(project.schema.map((d) => d.name)).toEqual(['Decision', 'Reason'])
    expect(project.papers.map((p) => p.id).sort()).toEqual(['inc', 'und', 'weird'])
    // First-pass decisions are dropped — every carried paper starts undecided
    // under the new (full-text) reason list.
    expect(project.papers.every((p) => screeningStatus(p.annotations) === 'undecided')).toBe(true)
    expect(project.provenance).toEqual({
      kind: 'screening-import',
      source: { file: 'screening.json' },
      importedAt: expect.any(String),
      counts: { included: 1, undecided: 2, excluded: 1, carried: 3 },
    })
  })

  it('editor round-trip: opening the saved file parses provenance and keeps it out of extra', async () => {
    await useEditorStore.getState().startFromScreening()
    // The screening target, not annotation: the carried rows have no PDFs
    // (a real title/abstract export), which only a screening project's
    // relaxed pdf rule accepts — see `validateDraft`/`projectSchema`.
    useEditorStore.getState().setScreeningImportKind('screening')
    await useEditorStore.getState().resolveScreeningImport('include-undecided')
    const json = buildProjectJson(useEditorStore.getState())
    const text = JSON.stringify(json)

    const opened = editorStateFromOpened({ text, handle: SOURCE_HANDLE, name: 'screening-fulltext.json' })
    expect(opened.provenance).toEqual(useEditorStore.getState().provenance)
    expect('provenance' in opened.extra).toBe(false)

    useEditorStore.setState((s) => ({ ...s, ...opened, open: true, mode: 'edit' as const }))
    const reJson = buildProjectJson(useEditorStore.getState())
    const reText = JSON.stringify(reJson)
    expect((JSON.parse(reText).provenance as unknown)).toEqual(opened.provenance)
  })

  it('undo after an import leaves provenance intact', async () => {
    await useEditorStore.getState().startFromScreening()
    await useEditorStore.getState().resolveScreeningImport('include-undecided')
    const provenance = useEditorStore.getState().provenance
    expect(provenance).not.toBeNull()

    useEditorStore.getState().setTitle('Full-text pass')
    expect(useEditorStore.getState().title).toBe('Full-text pass')
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().title).toBe('')
    expect(useEditorStore.getState().provenance).toEqual(provenance)
  })

  it('importFromScreening still refuses on an already-open screening project', async () => {
    useEditorStore.setState({ screening: { reasons: ['X'] } })
    await useEditorStore.getState().importFromScreening()
    expect(useEditorStore.getState().screeningImport).toBeNull()
    expect(useEditorStore.getState().busy).toBe(false)
  })

  // Regression: merging carried papers into an editor session that is
  // ALREADY OPEN (importFromScreening's target: 'import') used to carry `pdf`
  // verbatim from the source screening project — correct only when the two
  // files happen to share a directory, which `target: 'start'` guarantees via
  // its sibling-location default but this path never did, since the open
  // project's own location can be anywhere.
  describe('importFromScreening rebases pdf against the already-open project\'s own location', () => {
    const OPEN_LOCATION: ProjectLocation = {
      handle: { kind: 'electron', path: '/annotation-reviews/project.json' },
      name: 'project.json',
      path: '/annotation-reviews/project.json',
    }

    beforeEach(() => {
      useEditorStore.setState({ open: true, mode: 'edit', screening: null, location: OPEN_LOCATION, papers: [] })
      openResult = {
        text: JSON.stringify({
          version: 1,
          config: { screening: { reasons: ['Wrong topic'] } },
          papers: [
            { id: 'inc', title: 'Included', authors: [], pdf: 'pdfs/inc.pdf', annotations: { Decision: [{ value: 'Include' }] } },
          ],
        }),
        handle: { kind: 'electron', path: '/reviews/screening.json' },
        name: 'screening.json',
      }
    })

    it('rebases pdf against the open project\'s location, not left verbatim from the source', async () => {
      relativeResult = ['../reviews/pdfs/inc.pdf']
      await useEditorStore.getState().importFromScreening()
      await useEditorStore.getState().resolveScreeningImport('include-undecided')

      const paper = useEditorStore.getState().papers.find((p) => p.id === 'inc')!
      // Not the verbatim source value — that would point at nothing once
      // written under the open project's own directory.
      expect(paper.pdf).not.toBe('pdfs/inc.pdf')
      expect(paper.pdf).toBe('../reviews/pdfs/inc.pdf')

      // Rebased against the OPEN project's own location, not the source's.
      expect(relativeCalls).toHaveLength(1)
      expect(relativeCalls[0].location).toEqual(OPEN_LOCATION)
      expect(relativeCalls[0].pdfs).toEqual([{ name: 'pdfs/inc.pdf', path: '/abs/pdfs/inc.pdf' }])
    })

    it('falls back to the verbatim pdf when the platform cannot rebase it (e.g. no absolute source)', async () => {
      // A paper with no pdf at all has nothing to rebase — absolutePdfPaths
      // (mocked above) returns undefined for a falsy path.
      openResult!.text = JSON.stringify({
        version: 1,
        config: { screening: { reasons: ['Wrong topic'] } },
        papers: [{ id: 'inc', title: 'Included', authors: [], pdf: '', annotations: { Decision: [{ value: 'Include' }] } }],
      })
      await useEditorStore.getState().importFromScreening()
      await useEditorStore.getState().resolveScreeningImport('include-undecided')

      const paper = useEditorStore.getState().papers.find((p) => p.id === 'inc')!
      expect(paper.pdf).toBe('')
      expect(relativeCalls).toHaveLength(0)
    })

    it('does not rebase for target: start — the sibling-location default already makes the verbatim path correct', async () => {
      useEditorStore.setState({ open: false })
      siblingResult = {
        handle: { kind: 'electron', path: '/reviews/screening-annotation.json' },
        name: 'screening-annotation.json',
        path: '/reviews/screening-annotation.json',
      }
      relativeResult = ['should-never-be-used.pdf']
      await useEditorStore.getState().startFromScreening()
      await useEditorStore.getState().resolveScreeningImport('include-undecided')

      const paper = useEditorStore.getState().papers.find((p) => p.id === 'inc')!
      expect(paper.pdf).toBe('pdfs/inc.pdf')
      expect(relativeCalls).toHaveLength(0)
    })
  })
})

// A new project should not silently claim a feature nobody can currently
// reach — see the doc comments on the initial state / startNew / the
// screening-import target:'start' branch in editorStore.ts, and
// ProjectEditor.tsx's own comment on why there is no UI to change this.
describe('a new project defaults to aiEnabled: false', () => {
  it('startNew()', async () => {
    pickResult = {
      handle: { kind: 'electron', path: '/reviews/project.json' },
      name: 'project.json',
      path: '/reviews/project.json',
    }
    await useEditorStore.getState().startNew()
    expect(useEditorStore.getState().aiEnabled).toBe(false)
    expect(JSON.parse(JSON.stringify(buildProjectJson(useEditorStore.getState()))).config.ai).toBe(false)
  })

  it('startFromScreening() → resolveScreeningImport (target: start)', async () => {
    openResult = {
      text: JSON.stringify({
        version: 1,
        config: { screening: { reasons: ['Wrong topic'] } },
        papers: [{ id: 'inc', title: 'Included', authors: [], pdf: '', annotations: { Decision: [{ value: 'Include' }] } }],
      }),
      handle: { kind: 'electron', path: '/reviews/screening.json' },
      name: 'screening.json',
    }
    siblingResult = {
      handle: { kind: 'electron', path: '/reviews/screening-annotation.json' },
      name: 'screening-annotation.json',
      path: '/reviews/screening-annotation.json',
    }
    await useEditorStore.getState().startFromScreening()
    await useEditorStore.getState().resolveScreeningImport('include-undecided')
    expect(useEditorStore.getState().aiEnabled).toBe(false)
  })

  it('does not touch an existing file\'s own aiEnabled — only new-project defaults changed', () => {
    const opened = editorStateFromOpened({
      text: JSON.stringify({
        version: 1,
        config: { schema: [{ name: 'X', type: 'string' }] }, // no "ai" key — enabled by default
        papers: [],
      }),
      handle: { kind: 'electron', path: '/reviews/existing.json' },
      name: 'existing.json',
    })
    expect(opened.aiEnabled).toBe(true)
  })
})
