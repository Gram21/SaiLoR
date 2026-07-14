import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SaveHandle } from '../platform/adapter'

/** Captures what the editor writes, so the save split can be asserted. */
let written: { text: string; handle: SaveHandle } | null = null

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  // loadFromText records the open project as a recent once it knows its title.
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  saveProject: async (text: string, handle: SaveHandle) => {
    written = { text, handle }
    return handle
  },
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore, makeNode } = await import('./editorStore')
const { useStore } = await import('./store')

const LOCATION = {
  handle: { kind: 'electron' as const, path: '/reviews/my-slr.json' },
  name: 'my-slr.json',
  path: '/reviews/my-slr.json',
}

function reset() {
  written = null
  useEditorStore.setState({
    open: true,
    mode: 'new',
    location: LOCATION,
    version: 1,
    extra: {},
    nodes: [],
    papers: [],
    dirty: false,
    busy: false,
    error: null,
    issues: [],
    notice: null,
    extracting: 0,
    past: [],
    future: [],
  })
  useStore.setState({ project: null })
}

const names = () => useEditorStore.getState().nodes.map((n) => n.name)

describe('editor undo/redo', () => {
  beforeEach(reset)

  it('undoes and redoes adding a field', () => {
    const ed = useEditorStore.getState()
    ed.addNode(null)
    expect(useEditorStore.getState().nodes).toHaveLength(1)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().nodes).toHaveLength(0)

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().nodes).toHaveLength(1)
  })

  it('collapses consecutive edits of one field into a single undo step', () => {
    useEditorStore.setState({ nodes: [makeNode()] })
    const uid = useEditorStore.getState().nodes[0].uid

    // Typing "Rel" one character at a time.
    useEditorStore.getState().updateNode(uid, { name: 'R' })
    useEditorStore.getState().updateNode(uid, { name: 'Re' })
    useEditorStore.getState().updateNode(uid, { name: 'Rel' })
    expect(names()).toEqual(['Rel'])

    // One undo returns to the pre-typing value, not to "Re".
    useEditorStore.getState().undo()
    expect(names()).toEqual([''])
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('starts a new undo step when a different field is edited', () => {
    useEditorStore.setState({ nodes: [makeNode(), makeNode()] })
    const [a, b] = useEditorStore.getState().nodes.map((n) => n.uid)
    useEditorStore.getState().updateNode(a, { name: 'A' })
    useEditorStore.getState().updateNode(b, { name: 'B' })

    useEditorStore.getState().undo()
    expect(names()).toEqual(['A', ''])
    useEditorStore.getState().undo()
    expect(names()).toEqual(['', ''])
  })

  it('undoes a drag-and-drop move', () => {
    useEditorStore.setState({ nodes: [makeNode(), makeNode()] })
    const [a, b] = useEditorStore.getState().nodes.map((n) => n.uid)
    useEditorStore.getState().updateNode(a, { name: 'A' })
    useEditorStore.getState().updateNode(b, { name: 'B' })

    useEditorStore.getState().moveNode(b, a, 'inside')
    expect(names()).toEqual(['A'])
    expect(useEditorStore.getState().nodes[0].children).toHaveLength(1)

    useEditorStore.getState().undo()
    expect(names()).toEqual(['A', 'B'])
  })

  it('a rejected move creates no undo step', () => {
    useEditorStore.setState({ nodes: [makeNode()] })
    const uid = useEditorStore.getState().nodes[0].uid
    const before = useEditorStore.getState().past.length
    // Dropping a node onto itself is a no-op.
    useEditorStore.getState().moveNode(uid, uid, 'inside')
    expect(useEditorStore.getState().past).toHaveLength(before)
  })

  it('a new edit clears the redo stack', () => {
    useEditorStore.getState().addNode(null)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().future).toHaveLength(1)

    useEditorStore.getState().addNode(null)
    expect(useEditorStore.getState().future).toHaveLength(0)
  })

  it('does nothing when there is no history', () => {
    useEditorStore.getState().undo()
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().nodes).toHaveLength(0)
  })
})

describe('save vs. save-and-annotate', () => {
  beforeEach(() => {
    reset()
    const node = { ...makeNode(), name: 'Relevant', kind: 'boolean' as const }
    useEditorStore.setState({ nodes: [node], dirty: true })
  })

  it('save writes the file and keeps the editor open', async () => {
    const ok = await useEditorStore.getState().save()
    expect(ok).toBe(true)
    expect(written?.text).toContain('"Relevant"')

    const st = useEditorStore.getState()
    expect(st.open).toBe(true) // still editing
    expect(st.dirty).toBe(false)
    expect(st.notice).toMatch(/saved to my-slr\.json/i)
    // It does NOT hand the project to the annotation view.
    expect(useStore.getState().project).toBeNull()
  })

  it('saveAndAnnotate writes, closes the editor, and loads the project', async () => {
    const ok = await useEditorStore.getState().saveAndAnnotate()
    expect(ok).toBe(true)
    expect(written?.text).toContain('"Relevant"')

    expect(useEditorStore.getState().open).toBe(false)
    const project = useStore.getState().project
    expect(project).not.toBeNull()
    expect(project?.schema.map((d) => d.name)).toEqual(['Relevant'])
  })

  it('neither saves nor closes when the draft is invalid', async () => {
    useEditorStore.setState({ nodes: [makeNode()] }) // unnamed field
    const ok = await useEditorStore.getState().saveAndAnnotate()
    expect(ok).toBe(false)
    expect(written).toBeNull()
    expect(useEditorStore.getState().open).toBe(true)
    expect(useEditorStore.getState().issues.join(' ')).toMatch(/no name/i)
  })
})
