import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { OpenedProject, ProjectLocation, SaveHandle } from '../platform/adapter'

let openResult: OpenedProject | null = null
let siblingResult: ProjectLocation | null = null
let pickResult: ProjectLocation | null = null

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  openProject: async () => openResult,
  pickProjectLocation: async () => pickResult,
  siblingProjectLocation: async () => siblingResult,
  absolutePdfPaths: async (paths: string[]) => paths.map((p) => (p ? `/abs/${p}` : undefined)),
  relativePdfPaths: async () => [],
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore, buildProjectJson, validateDraft, makeNode } = await import('./editorStore')
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
          { uid: 'u1', id: 'p1', title: 'Paper', authors: '', doi: '', abstract: '', pdf: '', annotations: {} },
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
          { uid: 'u1', id: 'p1', title: 'Paper', authors: '', doi: '', abstract: '', pdf: '', annotations: {} },
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
})
