// [utest->req~edt-40~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * REQ-EDT-40: warn before a rename or removal that would destroy recorded
 * answers. `countPapersUsingField`/`countLinksUsingField` (src/model/fieldUsage.ts)
 * are already unit-tested in fieldUsage.test.ts; what's untested is that
 * `SchemaTreeEditor` actually surfaces a `window.confirm` for it and respects
 * the answer.
 */
const mockPlatform = {
  kind: 'browser' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore, makeNode } = await import('../state/editorStore')
const { SchemaTreeEditor } = await import('./SchemaTreeEditor')
const { useGitStore } = await import('../state/gitStore')

function reset() {
  const field = { ...makeNode(), name: 'Study Type', kind: 'string' as const }
  useEditorStore.setState({
    open: true,
    mode: 'new',
    nodes: [field],
    papers: [
      {
        uid: 'p1',
        id: 'p1',
        title: 'A Paper',
        authors: '',
        doi: '',
        year: '',
        venue: '',
        abstract: '',
        pdf: 'a.pdf',
        annotations: { 'Study Type': [{ value: 'RCT' }] },
      },
    ],
    dirty: false,
    justAdded: {},
    past: [],
    future: [],
  })
}

beforeEach(() => {
  reset()
  useGitStore.setState({ repo: null, behind: null })
})

describe('SchemaTreeEditor: warns before destroying answers', () => {
  it('asks for confirmation when removing a field a paper has answered', async () => {
    render(<SchemaTreeEditor />)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    await userEvent.click(screen.getByTitle('Remove this field and its children'))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('1 paper records an answer'))
    // Declined: the field is still there.
    expect(useEditorStore.getState().nodes).toHaveLength(1)
    confirmSpy.mockRestore()
  })

  it('removes the field once the reviewer confirms', async () => {
    render(<SchemaTreeEditor />)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    await userEvent.click(screen.getByTitle('Remove this field and its children'))

    expect(useEditorStore.getState().nodes).toHaveLength(0)
    confirmSpy.mockRestore()
  })

  it('removes an unanswered field without asking', async () => {
    useEditorStore.setState({
      papers: [
        {
          uid: 'p1',
          id: 'p1',
          title: 'A Paper',
          authors: '',
          doi: '',
          year: '',
          venue: '',
          abstract: '',
          pdf: 'a.pdf',
          annotations: {},
        },
      ],
    })
    render(<SchemaTreeEditor />)
    const confirmSpy = vi.spyOn(window, 'confirm')

    await userEvent.click(screen.getByTitle('Remove this field and its children'))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(useEditorStore.getState().nodes).toHaveLength(0)
    confirmSpy.mockRestore()
  })

  it('asks on a committed rename, and reverts the name if the reviewer declines', async () => {
    render(<SchemaTreeEditor />)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const nameInput = screen.getByPlaceholderText('Field name')
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'Design')
    await userEvent.tab() // blur commits the rename

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('1 paper records an answer'))
    expect(useEditorStore.getState().nodes[0].name).toBe('Study Type')
    confirmSpy.mockRestore()
  })
})

describe('SchemaTreeEditor: known-unpulled work sharpens the warning', () => {
  const repo = (behind: number | null) => ({
    root: '/repo',
    relPath: 'x.json',
    branch: 'main',
    upstream: 'origin/main',
    hasHead: true,
    annotationsDir: 'annotations',
    behind,
  })

  it('says how far behind the branch is when the repository already knows', async () => {
    useGitStore.setState({ repo: repo(4), behind: 4 })
    render(<SchemaTreeEditor />)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    await userEvent.click(screen.getByTitle('Remove this field and its children'))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('4 commits behind its upstream'))
    confirmSpy.mockRestore()
  })

  it('adds nothing when nothing is known — silence is not "you are up to date"', async () => {
    // `behind` comes from refs alone, with no fetch, so zero and unknown both
    // mean "we cannot say", and the warning must not imply otherwise.
    for (const value of [0, null]) {
      useGitStore.setState({ repo: repo(value), behind: value })
      const view = render(<SchemaTreeEditor />)
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

      await userEvent.click(screen.getAllByTitle('Remove this field and its children')[0])

      expect(confirmSpy).toHaveBeenCalledWith(expect.not.stringContaining('behind its upstream'))
      confirmSpy.mockRestore()
      view.unmount()
    }
  })
})

// [utest->req~edt-100~1]
describe('SchemaTreeEditor: unique option', () => {
  it('offers Unique only on a repeatable field and a uniqueBy picker for its children', async () => {
    const { toAnnotationDefs, fromAnnotationDefs } = await import('../state/editorStore')
    const nodes = fromAnnotationDefs([
      {
        name: 'Authors',
        min: 0,
        max: null,
        children: [
          { name: 'Name', type: 'string' },
          { name: 'Role', type: 'string' },
        ],
      },
      { name: 'Title', type: 'string' },
    ])
    useEditorStore.setState({ nodes })
    render(<SchemaTreeEditor />)

    const unique = screen.getAllByRole('checkbox', { name: 'Unique' })
    expect(unique).toHaveLength(1)
    await userEvent.click(unique[0])
    await userEvent.click(screen.getByRole('checkbox', { name: 'Name' }))

    const defs = toAnnotationDefs(useEditorStore.getState().nodes)
    expect(defs[0]).toMatchObject({ unique: true, uniqueBy: ['Name'] })
    expect(defs[1].unique).toBeUndefined()
    expect(toAnnotationDefs(fromAnnotationDefs(defs))).toEqual(defs)
  })
})

describe('SchemaTreeEditor: moving fields', () => {
  it('moves a field one step up or down within its level', async () => {
    const { fromAnnotationDefs } = await import('../state/editorStore')
    useEditorStore.setState({
      nodes: fromAnnotationDefs([
        { name: 'A', type: 'string' },
        { name: 'B', type: 'string' },
      ]),
    })
    render(<SchemaTreeEditor />)
    const names = () => useEditorStore.getState().nodes.map((n) => n.name)
    const ups = screen.getAllByRole('button', { name: 'Move up within this level' })
    const downs = screen.getAllByRole('button', { name: 'Move down within this level' })
    expect(ups[0]).toBeDisabled()
    expect(downs[1]).toBeDisabled()
    await userEvent.click(downs[0])
    expect(names()).toEqual(['B', 'A'])
    await userEvent.click(screen.getAllByRole('button', { name: 'Move up within this level' })[1])
    expect(names()).toEqual(['A', 'B'])
  })

  it('makes only the handle draggable', () => {
    render(<SchemaTreeEditor />)
    expect(document.querySelector('.schema-handle')).toHaveAttribute('draggable', 'true')
    expect(document.querySelector('.schema-row')).not.toHaveAttribute('draggable')
  })
})

describe('brokenGateFields', () => {
  it('flags a condition whose field was removed, and marks the gate red', async () => {
    const { fromAnnotationDefs, brokenGateFields } = await import('../state/editorStore')
    const nodes = fromAnnotationDefs([
      { name: 'Relevant', type: 'boolean' },
      { name: 'Reason', type: 'string', visibleIf: 'Relevant' },
      { name: 'Other', type: 'string', visibleIf: { mode: 'any', conditions: [{ field: 'Relevant' }] } },
    ])
    expect(brokenGateFields(nodes).size).toBe(0)
    useEditorStore.setState({ nodes })
    const uid = useEditorStore.getState().nodes[0].uid
    useEditorStore.getState().removeNode(uid)
    const broken = brokenGateFields(useEditorStore.getState().nodes)
    expect([...broken.values()]).toEqual([['Relevant'], ['Relevant']])
    render(<SchemaTreeEditor />)
    expect(document.querySelectorAll('.schema-visible-if.invalid')).toHaveLength(2)
  })

  it('follows a rename in sibling, nested and path conditions', async () => {
    const { fromAnnotationDefs, brokenGateFields } = await import('../state/editorStore')
    const nodes = fromAnnotationDefs([
      { name: 'Relevant', type: 'boolean' },
      { name: 'Reason', type: 'string', visibleIf: 'Relevant' },
      { name: 'Other', type: 'string', visibleIf: { mode: 'any', conditions: [{ field: 'Relevant' }] } },
      { name: 'Grp', children: [{ name: 'Inner', type: 'string' }] },
      { name: 'Far', type: 'string', visibleIf: 'Grp/Inner' },
    ])
    useEditorStore.setState({ nodes })
    const es = useEditorStore.getState()
    const uid = (n: string) => useEditorStore.getState().nodes.find((x) => x.name === n)!.uid
    es.updateNode(uid('Relevant'), { name: 'Eligible' })
    es.renameGateRefs(uid('Eligible'), 'Relevant')
    es.updateNode(uid('Grp'), { name: 'Section' })
    es.renameGateRefs(uid('Section'), 'Grp')
    const after = useEditorStore.getState().nodes
    const field = (n: string) => {
      const v = after.find((x) => x.name === n)!.visibleIf!
      return (v.conditions[0] as { field: string }).field
    }
    expect(field('Reason')).toBe('Eligible')
    expect(field('Other')).toBe('Eligible')
    expect(field('Far')).toBe('Section/Inner')
    expect(brokenGateFields(after).size).toBe(0)
  })
})
