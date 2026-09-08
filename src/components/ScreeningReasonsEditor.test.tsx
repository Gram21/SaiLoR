import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

const { useEditorStore } = await import('../state/editorStore')
const { ScreeningReasonsEditor } = await import('./ScreeningReasonsEditor')

const LOCATION = { handle: { kind: 'browser' as const }, name: 'project.json', path: undefined }

function reset(opts: { reasons?: string[]; papers?: import('../state/editorStore').EditorPaper[] } = {}) {
  useEditorStore.setState({
    open: true,
    mode: 'new',
    location: LOCATION,
    version: 1,
    title: '',
    aiEnabled: false,
    finishCheckbox: true,
    reviewers: 1,
    screening: { reasons: opts.reasons ?? ['Wrong topic', 'Duplicate', 'Other'] },
    extra: {},
    provenance: null,
    protocol: null,
    schemaInfo: null,
    nodes: [],
    papers: opts.papers ?? [],
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
  } as never)
}

beforeEach(() => {
  reset()
})

describe('ScreeningReasonsEditor: ordered list (REQ-SCR-250)', () => {
  it('renders reasons as an ordered list, in order', () => {
    render(<ScreeningReasonsEditor />)
    const list = screen.getByRole('list')
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(within(items[0]).getByDisplayValue('Wrong topic')).toBeInTheDocument()
    expect(within(items[1]).getByDisplayValue('Duplicate')).toBeInTheDocument()
    expect(within(items[2]).getByDisplayValue('Other')).toBeInTheDocument()
  })

  it('adds a new blank reason at the end', async () => {
    render(<ScreeningReasonsEditor />)
    await userEvent.click(screen.getByRole('button', { name: '+ Add reason' }))
    expect(useEditorStore.getState().screening?.reasons).toEqual(['Wrong topic', 'Duplicate', 'Other', ''])
  })

  it('removes an unused reason immediately, no confirmation needed', async () => {
    render(<ScreeningReasonsEditor />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove "Duplicate"' }))
    expect(useEditorStore.getState().screening?.reasons).toEqual(['Wrong topic', 'Other'])
  })

  it('reorders with the up/down buttons', async () => {
    render(<ScreeningReasonsEditor />)
    await userEvent.click(screen.getByRole('button', { name: 'Move "Duplicate" up' }))
    expect(useEditorStore.getState().screening?.reasons).toEqual(['Duplicate', 'Wrong topic', 'Other'])

    await userEvent.click(screen.getByRole('button', { name: 'Move "Duplicate" down' }))
    await userEvent.click(screen.getByRole('button', { name: 'Move "Duplicate" down' }))
    expect(useEditorStore.getState().screening?.reasons).toEqual(['Wrong topic', 'Other', 'Duplicate'])
  })

  it('disables moving the first item up and the last item down', () => {
    render(<ScreeningReasonsEditor />)
    expect(screen.getByRole('button', { name: 'Move "Wrong topic" up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move "Other" down' })).toBeDisabled()
  })
})

describe('ScreeningReasonsEditor: confirm removal in use (REQ-SCR-270)', () => {
  it('warns before removing a reason a paper still records, and cancelling keeps it', async () => {
    reset({
      reasons: ['Wrong topic', 'Duplicate'],
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
          pdf: '',
          annotations: { Decision: [{ value: 'Exclude' }], Reason: [{ value: 'Duplicate' }] },
        },
      ],
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ScreeningReasonsEditor />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove "Duplicate"' }))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('1 paper'))
    expect(useEditorStore.getState().screening?.reasons).toEqual(['Wrong topic', 'Duplicate'])
    confirmSpy.mockRestore()
  })

  it('removes the reason once the removal is confirmed', async () => {
    reset({
      reasons: ['Wrong topic', 'Duplicate'],
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
          pdf: '',
          annotations: { Decision: [{ value: 'Exclude' }], Reason: [{ value: 'Duplicate' }] },
        },
      ],
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ScreeningReasonsEditor />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove "Duplicate"' }))

    expect(useEditorStore.getState().screening?.reasons).toEqual(['Wrong topic'])
    confirmSpy.mockRestore()
  })

  it('does not prompt when removing a reason nothing uses', async () => {
    reset({
      reasons: ['Wrong topic', 'Duplicate'],
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
          pdf: '',
          annotations: { Decision: [{ value: 'Exclude' }], Reason: [{ value: 'Wrong topic' }] },
        },
      ],
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ScreeningReasonsEditor />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove "Duplicate"' }))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(useEditorStore.getState().screening?.reasons).toEqual(['Wrong topic'])
    confirmSpy.mockRestore()
  })
})
