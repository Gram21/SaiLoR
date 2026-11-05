// [utest->req~edt-310~1]
// [utest->req~edt-320~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { useEditorStore, makeNode, type EditorPaper } from '../state/editorStore'
import { SchemaPreview } from './SchemaPreview'

function paper(uid: string, title: string): EditorPaper {
  return { uid, id: uid, title, authors: '', doi: '', year: '', venue: '', abstract: '', pdf: `${uid}.pdf` }
}

function draftNodes() {
  return [
    { ...makeNode(), name: 'Relevant', kind: 'boolean' as const },
    {
      ...makeNode(),
      name: 'Reason',
      required: true,
      visibleIf: { mode: 'all' as const, conditions: [{ field: 'Relevant', equals: [true] }] },
    },
    { ...makeNode(), name: 'Tag', min: 0, max: null },
  ]
}

function projectJson() {
  return JSON.stringify({
    version: 1,
    title: 'Real Review',
    config: { schema: [{ name: 'Study Type', type: 'string' }] },
    papers: [{ id: 'p1', title: 'Real Paper', authors: [], pdf: 'a.pdf', annotations: {} }],
  })
}

beforeEach(() => {
  useStore.getState().loadFromText(projectJson(), null, 'real.json')
  useStore.getState().selectPaper('p1')
  useEditorStore.setState({
    open: true,
    nodes: draftNodes(),
    papers: [paper('a', 'First Paper'), paper('b', 'Second Paper')],
    screening: null,
    dirty: false,
    past: [],
    future: [],
  })
})

describe('SchemaPreview: the draft schema as a throwaway annotation form', () => {
  it('shows the banner and renders against the first paper, with a picker', async () => {
    render(<SchemaPreview />)
    expect(screen.getByRole('status')).toHaveTextContent('Preview: nothing you enter here is saved.')
    expect(screen.getByText('First Paper', { selector: '.annotations-paper-title' })).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sample paper' }), 'b')
    expect(screen.getByText('Second Paper', { selector: '.annotations-paper-title' })).toBeInTheDocument()
  })

  it('reacts to visibleIf, adds and removes instances and shows validation hints', async () => {
    render(<SchemaPreview />)
    expect(screen.queryByRole('textbox', { name: 'Reason' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Relevant' }))
    expect(screen.getByRole('textbox', { name: 'Reason' })).toBeInTheDocument()
    expect(screen.getByText('"Reason" is required but empty.')).toBeInTheDocument()

    await userEvent.type(screen.getByRole('textbox', { name: 'Reason' }), 'On topic')
    expect(screen.queryByText('"Reason" is required but empty.')).not.toBeInTheDocument()

    expect(screen.getAllByRole('textbox', { name: /^Tag #/ })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }))
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }))
    expect(screen.getAllByRole('textbox', { name: /^Tag #/ })).toHaveLength(3)
    await userEvent.click(screen.getAllByRole('button', { name: '×' })[0])
    expect(screen.getAllByRole('textbox', { name: /^Tag #/ })).toHaveLength(2)
  })

  it('leaves the project store, its dirty flag and undo history, and the draft untouched', async () => {
    const app = useStore.getState()
    const before = { project: app.project, dirty: app.dirty, past: app.past, future: app.future }
    const draft = useEditorStore.getState()
    const draftBefore = { nodes: draft.nodes, papers: draft.papers, dirty: draft.dirty, past: draft.past }

    render(<SchemaPreview />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Relevant' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason' }), 'On topic')
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }))
    await userEvent.click(screen.getAllByRole('button', { name: '×' })[0])

    const after = useStore.getState()
    expect(after.project).toBe(before.project)
    expect(after.dirty).toBe(before.dirty)
    expect(after.past).toBe(before.past)
    expect(after.future).toBe(before.future)
    expect(after.project?.papers[0].annotations).toEqual({ 'Study Type': [{ value: null }] })
    const draftAfter = useEditorStore.getState()
    expect(draftAfter.nodes).toBe(draftBefore.nodes)
    expect(draftAfter.papers).toBe(draftBefore.papers)
    expect(draftAfter.dirty).toBe(false)
    expect(draftAfter.past).toBe(draftBefore.past)
  })

  it('discards the answers once it unmounts', () => {
    const first = render(<SchemaPreview />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Relevant' }))
    expect(screen.getByRole('checkbox', { name: 'Relevant' })).toBeChecked()
    first.unmount()
    render(<SchemaPreview />)
    expect(screen.getByRole('checkbox', { name: 'Relevant' })).not.toBeChecked()
  })

  it('lists the problems instead of the form when the draft schema is invalid', () => {
    useEditorStore.setState({ nodes: [{ ...makeNode(), name: '' }] })
    render(<SchemaPreview />)
    expect(screen.getByRole('alert')).toHaveTextContent('Fix these problems in the schema to see the preview:')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})
