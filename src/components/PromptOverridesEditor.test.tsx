// [utest->req~llm-794~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { SaveHandle } from '../platform/adapter'

const mockPlatform = {
  kind: 'browser' as const,
  getOsInfo: () => null,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  pickProjectLocation: async () => null,
  saveProject: async (_text: string, handle: SaveHandle) => handle,
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore, makeNode, buildProjectJson, editorStateFromOpened } = await import('../state/editorStore')
const { PromptOverridesEditor } = await import('./PromptOverridesEditor')
const { DEFAULT_ROLE } = await import('../llm/prompt')

const st = () => useEditorStore.getState()

beforeEach(() => {
  useEditorStore.setState({
    open: true,
    screening: null,
    busy: false,
    dirty: false,
    promptOverrides: {},
    nodes: [{ ...makeNode(), name: 'Year', kind: 'number', description: 'Year of publication.' }],
    past: [],
    future: [],
  })
})

describe('PromptOverridesEditor', () => {
  it('shows the built-in role and writes a role override', () => {
    render(<PromptOverridesEditor />)
    expect(screen.getByText(DEFAULT_ROLE, { selector: 'q' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Role' }), { target: { value: 'You are a test reviewer.' } })
    expect(st().promptOverrides.role).toBe('You are a test reviewer.')
    expect(st().dirty).toBe(true)
  })

  it('resets the role to the built-in text', () => {
    useEditorStore.setState({ promptOverrides: { role: 'Custom.' } })
    render(<PromptOverridesEditor />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset to default' })[0])
    expect(st().promptOverrides.role).toBe('')
    expect(screen.getByRole('textbox', { name: 'Role' })).toHaveValue('')
  })

  it('edits and resets the help of one field, with the schema description as the default', () => {
    render(<PromptOverridesEditor />)
    const help = screen.getByRole('textbox', { name: 'Year' })
    expect(help).toHaveAttribute('placeholder', 'Year of publication.')
    fireEvent.change(help, { target: { value: 'Four-digit year.' } })
    expect(st().promptOverrides.fieldHelp).toEqual({ Year: 'Four-digit year.' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset to default' })[2])
    expect(st().promptOverrides.fieldHelp).toEqual({})
  })

  it('lists help for a field the schema no longer has and lets the user remove it', () => {
    useEditorStore.setState({ promptOverrides: { fieldHelp: { Gone: 'Old help.' } } })
    render(<PromptOverridesEditor />)
    expect(screen.getByText(/"Gone" matches no field/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(st().promptOverrides.fieldHelp).toEqual({})
  })
})

describe('editor store and prompt overrides', () => {
  // [utest->req~llm-790~1]
  it('writes only non-empty overrides into the project config', () => {
    const draft = { version: 1, aiEnabled: true, reviewers: 1, extra: {}, nodes: st().nodes, papers: [] }
    const config = (promptOverrides: object) =>
      (buildProjectJson({ ...draft, promptOverrides }) as { config: Record<string, unknown> }).config
    expect(config({ role: ' Custom. ', examples: '  ', fieldHelp: { Year: '' } }).promptOverrides).toEqual({ role: 'Custom.' })
    expect(config({ role: ' ' })).not.toHaveProperty('promptOverrides')
  })

  // [utest->req~llm-791~1]
  it('refuses to open a project file with invalid overrides and opens valid ones', () => {
    const text = (promptOverrides: unknown) =>
      JSON.stringify({ version: 1, config: { schema: [{ name: 'Year', type: 'number' }], promptOverrides }, papers: [] })
    const opened = (t: string) => ({ text: t, handle: { kind: 'download' as const }, name: 'p.json' })
    expect(() => editorStateFromOpened(opened(text({ role: 7 })))).toThrow()
    expect(editorStateFromOpened(opened(text({ role: 'R.' }))).promptOverrides).toEqual({ role: 'R.' })
  })
})
