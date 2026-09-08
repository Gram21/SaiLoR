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

beforeEach(reset)

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
