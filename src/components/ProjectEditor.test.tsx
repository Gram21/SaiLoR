// [utest->req~llm-650~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SaveHandle } from '../platform/adapter'

/**
 * REQ-EDT-10: a draft is validated (editorStore's `validateDraft`) before it
 * is written to disk. Drives this through the real Save button rather than
 * calling `validateDraft`/`save` directly, so the wiring between the button,
 * the store, and the "Fix these before saving" panel is what's actually
 * under test.
 */
let saved = 0

const mockPlatform = {
  kind: 'browser' as const,
  getOsInfo: () => null,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  pickProjectLocation: async () => null,
  saveProject: async (_text: string, handle: SaveHandle) => {
    saved++
    return handle
  },
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore, makeNode } = await import('../state/editorStore')
const { ProjectEditor } = await import('./ProjectEditor')

const LOCATION = { handle: { kind: 'download' as const }, name: 'project.json', path: undefined }

function reset() {
  useEditorStore.setState({
    open: true,
    mode: 'new',
    location: LOCATION,
    version: 1,
    title: '',
    aiEnabled: false,
    finishCheckbox: true,
    reviewers: 1,
    screening: null,
    extra: {},
    provenance: null,
    protocol: null,
    schemaInfo: null,
    nodes: [{ ...makeNode(), name: 'Relevant', kind: 'boolean' }],
    papers: [],
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

function renderSettings() {
  render(<ProjectEditor />)
  fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
}

beforeEach(() => {
  saved = 0
  reset()
})

describe('ProjectEditor: validates the draft before saving', () => {
  it('blocks the save and lists the problems when the draft is invalid', async () => {
    // No papers at all: validateDraft has nothing to complain about there,
    // so add one with no PDF and no id, which it does reject.
    useEditorStore.setState({
      papers: [
        {
          uid: 'p1',
          id: '',
          title: '',
          authors: '',
          doi: '',
          year: '',
          venue: '',
          abstract: '',
          pdf: '',
        },
      ],
    })
    render(<ProjectEditor />)

    await userEvent.click(screen.getByRole('button', { name: 'Save JSON' }))

    expect(screen.getByText('Fix these before saving:')).toBeInTheDocument()
    expect(screen.getByText(/missing id/)).toBeInTheDocument()
    expect(screen.getByText(/missing title/)).toBeInTheDocument()
    expect(screen.getByText(/has no PDF attached/)).toBeInTheDocument()
    expect(saved).toBe(0)
  })

  it('saves once the draft is valid, and clears any previous issue list', async () => {
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
        },
      ],
    })
    render(<ProjectEditor />)

    await userEvent.click(screen.getByRole('button', { name: 'Save JSON' }))

    expect(screen.queryByText('Fix these before saving:')).not.toBeInTheDocument()
    expect(saved).toBe(1)
  })

  it('an empty schema (no fields) is also rejected', async () => {
    useEditorStore.setState({
      nodes: [],
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
        },
      ],
    })
    render(<ProjectEditor />)

    await userEvent.click(screen.getByRole('button', { name: 'Save JSON' }))

    expect(screen.getByText(/needs at least one field/)).toBeInTheDocument()
    expect(saved).toBe(0)
  })
})

describe('ProjectEditor: AI seat toggle enabling rules', () => {
  it('is disabled when AI-assisted annotation is not allowed, even with 2+ reviewers', () => {
    useEditorStore.setState({ aiEnabled: false, reviewers: 2 })
    renderSettings()
    expect(screen.getByRole('checkbox', { name: /AI takes one reviewer seat/ })).toBeDisabled()
  })

  it('is disabled with fewer than 2 reviewers, even with AI allowed', () => {
    useEditorStore.setState({ aiEnabled: true, reviewers: 1 })
    renderSettings()
    expect(screen.getByRole('checkbox', { name: /AI takes one reviewer seat/ })).toBeDisabled()
  })

  it('is enabled once AI is allowed and there are 2+ reviewers', () => {
    useEditorStore.setState({ aiEnabled: true, reviewers: 2 })
    renderSettings()
    expect(screen.getByRole('checkbox', { name: /AI takes one reviewer seat/ })).toBeEnabled()
  })

  it('is offered in a screening draft too, with its own AI toggle', () => {
    useEditorStore.setState({ aiEnabled: true, reviewers: 2, screening: { reasons: ['Wrong topic'] } })
    renderSettings()
    expect(screen.getByRole('checkbox', { name: /Allow AI-assisted screening/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /AI takes one reviewer seat/ })).toBeEnabled()
  })

  it('toggling it calls setAiSeat and checks the box', async () => {
    useEditorStore.setState({ aiEnabled: true, reviewers: 3 })
    renderSettings()
    const checkbox = screen.getByRole('checkbox', { name: /AI takes one reviewer seat \(Reviewer 3\)/ })
    expect(checkbox).not.toBeChecked()
    await userEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(useEditorStore.getState().aiSeat).toBe(true)
  })
})

// [utest->req~llm-794~1]
describe('ProjectEditor: AI prompt section', () => {
  it('is in the Settings tab of an annotation draft and absent in a screening draft', () => {
    const { unmount } = render(<ProjectEditor />)
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(screen.getByRole('heading', { name: 'AI prompt' })).toBeInTheDocument()
    unmount()
    useEditorStore.setState({ screening: { reasons: ['Wrong topic'] } })
    renderSettings()
    expect(screen.queryByRole('heading', { name: 'AI prompt' })).toBeNull()
  })
})

// [utest->req~edt-300~1]
describe('ProjectEditor: tabs', () => {
  const tab = (name: string) => screen.getByRole('tab', { name })

  it('starts on Schema and moves with the arrow, Home and End keys', () => {
    render(<ProjectEditor />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Schema', 'Papers', 'Settings', 'Preview'])
    expect(tab('Schema')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'editor-tab-schema')

    fireEvent.keyDown(tab('Schema'), { key: 'ArrowRight' })
    expect(tab('Papers')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Papers')).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'editor-panel-papers')

    fireEvent.keyDown(tab('Papers'), { key: 'End' })
    expect(tab('Preview')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tab('Preview'), { key: 'ArrowRight' })
    expect(tab('Schema')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tab('Schema'), { key: 'ArrowLeft' })
    expect(tab('Preview')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tab('Preview'), { key: 'Home' })
    expect(tab('Schema')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Schema')).toHaveAttribute('tabindex', '0')
    expect(tab('Papers')).toHaveAttribute('tabindex', '-1')
  })

  it('swaps the arrow keys in a right-to-left locale', () => {
    document.documentElement.dir = 'rtl'
    try {
      render(<ProjectEditor />)
      fireEvent.keyDown(tab('Schema'), { key: 'ArrowLeft' })
      expect(tab('Papers')).toHaveAttribute('aria-selected', 'true')
      fireEvent.keyDown(tab('Papers'), { key: 'ArrowRight' })
      expect(tab('Schema')).toHaveAttribute('aria-selected', 'true')
    } finally {
      document.documentElement.dir = ''
    }
  })

  it('keeps the draft when switching tabs and saves nothing', async () => {
    renderSettings()
    await userEvent.type(screen.getByPlaceholderText(/project\.json/), 'My review')
    fireEvent.click(tab('Schema'))
    fireEvent.click(tab('Papers'))
    fireEvent.click(tab('Settings'))
    expect(screen.getByDisplayValue('My review')).toBeInTheDocument()
    expect(useEditorStore.getState().title).toBe('My review')
    expect(useEditorStore.getState().nodes[0].name).toBe('Relevant')
    expect(useEditorStore.getState().dirty).toBe(true)
    expect(saved).toBe(0)
  })

  it('jumps from a "Paper N" issue to the Papers tab', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    useEditorStore.setState({
      papers: [{ uid: 'p1', id: '', title: '', authors: '', doi: '', year: '', venue: '', abstract: '', pdf: '' }],
    })
    render(<ProjectEditor />)
    await userEvent.click(screen.getByRole('button', { name: 'Save JSON' }))
    await userEvent.click(screen.getAllByRole('button', { name: /^Paper 1/ })[0])
    expect(tab('Papers')).toHaveAttribute('aria-selected', 'true')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('offers no Preview tab for a screening draft', () => {
    useEditorStore.setState({ screening: { reasons: ['Wrong topic'] } })
    render(<ProjectEditor />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Schema', 'Papers', 'Settings'])
  })
})
