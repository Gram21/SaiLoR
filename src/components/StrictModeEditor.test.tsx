import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EditorPaper } from '../state/editorStore'

const mockPlatform = {
  kind: 'browser' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore, buildProjectJson, editorStateFromOpened, makeNode } = await import('../state/editorStore')
const { StrictModeEditor } = await import('./StrictModeEditor')

const paper = (uid: string, id: string, extra: Record<string, unknown> = {}): EditorPaper => ({
  uid,
  id,
  title: `Title ${id}`,
  authors: '',
  doi: '',
  year: '',
  venue: '',
  abstract: '',
  pdf: `${id}.pdf`,
  extra,
})

beforeEach(() => {
  useEditorStore.setState({
    reviewers: 2,
    aiSeat: false,
    aiEnabled: false,
    strict: null,
    papers: [paper('u1', 'a'), paper('u2', 'b', { reviewsFinished: { '1': true } }), paper('u3', 'c')],
    past: [],
    future: [],
    error: null,
    busy: false,
  })
})

describe('StrictModeEditor', () => {
  it('states that strict mode is not security', () => {
    render(<StrictModeEditor />)
    expect(screen.getByRole('note')).toHaveTextContent(/workflow aid, not security/)
  })

  it('turns strict mode on and adds, renames and removes persons', async () => {
    render(<StrictModeEditor />)
    await userEvent.click(screen.getByLabelText('Use strict mode'))
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }))
    expect(useEditorStore.getState().strict).toEqual({
      enabled: true,
      persons: [
        { id: 'p1', name: 'Person 1' },
        { id: 'p2', name: 'Person 2' },
      ],
      assignments: {},
    })
    const name = screen.getByLabelText('Name of person p1')
    await userEvent.clear(name)
    await userEvent.type(name, 'Ann')
    expect(useEditorStore.getState().strict?.persons[0].name).toBe('Ann')
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1])
    expect(useEditorStore.getState().strict?.persons.map((p) => p.id)).toEqual(['p1'])
  })

  it('assigns in bulk, shows counts and refuses to remove a person with finished work', async () => {
    useEditorStore.setState({
      strict: {
        enabled: true,
        persons: [
          { id: 'p1', name: 'Ann' },
          { id: 'p2', name: 'Bob' },
        ],
        assignments: {},
      },
    })
    render(<StrictModeEditor />)
    await userEvent.click(screen.getByRole('button', { name: 'Assign papers without persons' }))
    expect(useEditorStore.getState().strict?.assignments).toEqual({
      u1: [{ person: 'p1', seat: 1 }, { person: 'p2', seat: 2 }],
      u2: [{ person: 'p1', seat: 1 }, { person: 'p2', seat: 2 }],
      u3: [{ person: 'p1', seat: 1 }, { person: 'p2', seat: 2 }],
    })
    expect(screen.getByText('3 assigned, 1 finished')).toBeInTheDocument()
    expect(screen.getByText('3 assigned, 0 finished')).toBeInTheDocument()

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0])
    expect(useEditorStore.getState().error?.message).toMatch(/finished work/)
    expect(useEditorStore.getState().strict?.persons).toHaveLength(2)
  })

  it('locks a finished seat until the work is reopened', async () => {
    useEditorStore.setState({
      strict: { enabled: true, persons: [{ id: 'p1', name: 'Ann' }], assignments: { u2: [{ person: 'p1', seat: 1 }] } },
    })
    render(<StrictModeEditor />)
    const select = screen.getByLabelText('Person for b seat 1')
    expect(select).toBeDisabled()
    useEditorStore.getState().setAssignment('u2', 1, null)
    expect(useEditorStore.getState().error?.message).toMatch(/finished work/)

    await userEvent.click(within(select.parentElement!).getByRole('button', { name: 'Reopen' }))
    expect(useEditorStore.getState().papers[1].extra).toEqual({})
    expect(screen.getByLabelText('Person for b seat 1')).toBeEnabled()
    await userEvent.selectOptions(screen.getByLabelText('Person for b seat 1'), '')
    expect(useEditorStore.getState().strict?.assignments).toEqual({})
  })

  it('moves a person to the other seat of the same paper', async () => {
    useEditorStore.setState({
      strict: { enabled: true, persons: [{ id: 'p1', name: 'Ann' }], assignments: { u1: [{ person: 'p1', seat: 1 }] } },
    })
    render(<StrictModeEditor />)
    await userEvent.selectOptions(screen.getByLabelText('Person for a seat 2'), 'p1')
    expect(useEditorStore.getState().strict?.assignments.u1).toEqual([{ person: 'p1', seat: 2 }])
  })
})

describe('strict settings through the editor file', () => {
  it('keeps persons and assignments across open and save, keyed by paper id in the file', () => {
    const text = JSON.stringify({
      version: 1,
      config: {
        schema: [{ name: 'A', type: 'string' }],
        reviewers: 2,
        strict: true,
        persons: [{ id: 'p1', name: 'Ann' }],
        assignments: { a: [{ person: 'p1', seat: 2 }] },
      },
      papers: [{ id: 'a', title: 'A', authors: [], pdf: 'a.pdf' }],
    })
    const st = editorStateFromOpened({ handle: { kind: 'electron', path: '/x/project.json' } as never, name: 'p', text })
    const uid = st.papers[0].uid
    expect(st.strict?.assignments).toEqual({ [uid]: [{ person: 'p1', seat: 2 }] })
    const config = buildProjectJson(st).config as Record<string, unknown>
    expect(config.strict).toBe(true)
    expect(config.persons).toEqual([{ id: 'p1', name: 'Ann' }])
    expect(config.assignments).toEqual({ a: [{ person: 'p1', seat: 2 }] })
  })

  it('refuses to open a file with invalid strict settings', () => {
    const text = JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'A', type: 'string' }], reviewers: 2, persons: [{ id: 'p1', name: '' }] },
      papers: [],
    })
    expect(() => editorStateFromOpened({ handle: {} as never, name: 'p', text })).toThrow(/strict mode settings/)
  })

  it('writes nothing for a draft without strict settings', () => {
    const config = buildProjectJson({ version: 1, aiEnabled: false, reviewers: 2, extra: {}, nodes: [{ ...makeNode(), name: 'A' }], papers: [] })
      .config as Record<string, unknown>
    expect(Object.keys(config).sort()).toEqual(['reviewers', 'schema'])
  })
})
