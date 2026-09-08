import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

const LOCATION = { handle: { kind: 'browser' as const }, name: 'project.json', path: undefined }

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
