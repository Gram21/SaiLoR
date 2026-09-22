import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, createEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * Component-level coverage for:
 * - REQ-EDT-20: flag duplicate paper identifiers live, while typing.
 * - REQ-EDT-50: confirm before removing a paper that already has recorded
 *   annotations.
 * - REQ-EDT-90: reorder papers by drag. jsdom has no real drag-and-drop, but
 *   `fireEvent` can dispatch the native dragstart/dragover/drop events with a
 *   stand-in `dataTransfer`, which is enough to drive `PapersEditor`'s actual
 *   handlers end to end (not `movePaper` called directly).
 */
let pdfsPicked: { name: string; path?: string }[] = []

const mockPlatform = {
  kind: 'browser' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  pickPdfs: async () => pdfsPicked,
  relativePdfPaths: async (pdfs: { name: string }[]) => pdfs.map((p) => p.name),
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore, makePaperFromPdf, makeNode } = await import('../state/editorStore')
const { PapersEditor } = await import('./PapersEditor')

function reset() {
  useEditorStore.setState({
    open: true,
    mode: 'new',
    location: { handle: { kind: 'browser' as const }, name: 'project.json' },
    nodes: [{ ...makeNode(), name: 'Relevant', kind: 'boolean' }],
    papers: [],
    dirty: false,
    busy: false,
    screening: null,
    justAdded: {},
    past: [],
    future: [],
  })
}

beforeEach(() => {
  reset()
  pdfsPicked = []
})

describe('PapersEditor: create papers from PDFs (REQ-EDT-30)', () => {
  it('adds a row per picked PDF, name-derived and marked "just added"', async () => {
    pdfsPicked = [{ name: 'smith-2020.pdf', path: '/pdfs/smith-2020.pdf' }]
    render(<PapersEditor />)

    await userEvent.click(screen.getByRole('button', { name: '+ Add PDFs…' }))

    expect(await screen.findByDisplayValue('smith-2020')).toBeInTheDocument()
    const paper = useEditorStore.getState().papers[0]
    expect(paper.pdf).toBe('smith-2020.pdf')
    expect(useEditorStore.getState().justAdded[paper.uid]).toBe(true)
  })

  it('skips a PDF already in the project instead of adding a second row', async () => {
    const existing = makePaperFromPdf('smith-2020.pdf', 'smith-2020.pdf', '/pdfs/smith-2020.pdf', new Set())
    useEditorStore.setState({ papers: [existing] })
    pdfsPicked = [{ name: 'smith-2020.pdf', path: '/pdfs/smith-2020.pdf' }]
    render(<PapersEditor />)

    await userEvent.click(screen.getByRole('button', { name: '+ Add PDFs…' }))

    expect(useEditorStore.getState().papers).toHaveLength(1)
    await waitFor(() => expect(useEditorStore.getState().notice).toMatch(/Already in the project, skipped/))
  })
})

describe('PapersEditor: duplicate id flagging (REQ-EDT-20)', () => {
  it('marks both rows invalid once their ids match, live as the reviewer types', async () => {
    const a = makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())
    const b = makePaperFromPdf('b.pdf', 'b.pdf', undefined, new Set())
    a.id = 'one'
    b.id = 'two'
    useEditorStore.setState({ papers: [a, b] })
    render(<PapersEditor />)

    const idInputs = screen.getAllByDisplayValue(/^(one|two)$/)
    expect(idInputs.every((el) => el.getAttribute('aria-invalid') === 'false')).toBe(true)

    await userEvent.clear(idInputs[1])
    await userEvent.type(idInputs[1], 'one')

    const updated = screen.getAllByDisplayValue('one')
    expect(updated).toHaveLength(2)
    expect(updated.every((el) => el.getAttribute('aria-invalid') === 'true')).toBe(true)
    expect(screen.getAllByText('— duplicate')).toHaveLength(2)
  })
})

describe('PapersEditor: unsafe id flagging', () => {
  it('flags an id that is unsafe as a folder name, live as the reviewer types', async () => {
    const paper = makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())
    paper.id = 'one'
    useEditorStore.setState({ papers: [paper] })
    render(<PapersEditor />)

    const idInput = screen.getByDisplayValue('one')
    expect(idInput.getAttribute('aria-invalid')).toBe('false')

    // ':' and '?' are legal on macOS/Linux but unrepresentable on Windows.
    await userEvent.clear(idInput)
    await userEvent.type(idInput, 'Smith 2020: A Study?')

    expect(idInput.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('— invalid character')).toBeInTheDocument()
  })

  it('normalises a manually typed id to NFC once it is committed on blur', async () => {
    const paper = makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())
    paper.id = 'one'
    useEditorStore.setState({ papers: [paper] })
    render(<PapersEditor />)

    const idInput = screen.getByDisplayValue('one')
    // "Müller" spelled with a combining diaeresis (NFD) — the same rendered
    // text as the precomposed (NFC) form, but different code points, which
    // would name two different directories depending which platform typed it.
    const nfd = 'Müller'
    await userEvent.clear(idInput)
    await userEvent.type(idInput, nfd)
    fireEvent.blur(idInput)

    await waitFor(() => expect(useEditorStore.getState().papers[0].id).toBe(nfd.normalize('NFC')))
  })
})

describe('PapersEditor: confirm removal of annotated papers (REQ-EDT-50)', () => {
  it('asks before removing a paper with recorded annotations, and keeps it on Cancel', async () => {
    const paper = makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())
    paper.annotations = { Relevant: [{ value: true }] }
    useEditorStore.setState({ papers: [paper] })
    render(<PapersEditor />)

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await userEvent.click(screen.getByRole('button', { name: 'Remove this paper' }))

    expect(confirmSpy).toHaveBeenCalled()
    expect(useEditorStore.getState().papers).toHaveLength(1)
    confirmSpy.mockRestore()
  })

  it('removes it once the reviewer confirms', async () => {
    const paper = makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())
    paper.annotations = { Relevant: [{ value: true }] }
    useEditorStore.setState({ papers: [paper] })
    render(<PapersEditor />)

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await userEvent.click(screen.getByRole('button', { name: 'Remove this paper' }))

    expect(useEditorStore.getState().papers).toHaveLength(0)
    confirmSpy.mockRestore()
  })

  it('removes a paper with no recorded annotations without asking', async () => {
    const paper = makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())
    useEditorStore.setState({ papers: [paper] })
    render(<PapersEditor />)

    const confirmSpy = vi.spyOn(window, 'confirm')
    await userEvent.click(screen.getByRole('button', { name: 'Remove this paper' }))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(useEditorStore.getState().papers).toHaveLength(0)
    confirmSpy.mockRestore()
  })
})

describe('PapersEditor: confirm renaming the id of an annotated paper', () => {
  /** A paper's answers live in `annotations/<id>/`, so the id is what ties
   *  them to the paper — including answers other reviewers have not pushed. */
  const annotated = () => {
    const paper = makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())
    paper.id = 'old-id'
    paper.annotations = { Relevant: [{ value: true }] }
    return paper
  }

  it('puts the old id back when the reviewer cancels', async () => {
    useEditorStore.setState({ papers: [annotated()] })
    render(<PapersEditor />)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const idInput = screen.getByDisplayValue('old-id')
    await userEvent.clear(idInput)
    await userEvent.type(idInput, 'new-id')
    await userEvent.tab()

    expect(confirmSpy).toHaveBeenCalled()
    expect(useEditorStore.getState().papers[0].id).toBe('old-id')
    confirmSpy.mockRestore()
  })

  it('keeps the new id once the reviewer confirms', async () => {
    useEditorStore.setState({ papers: [annotated()] })
    render(<PapersEditor />)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    const idInput = screen.getByDisplayValue('old-id')
    await userEvent.clear(idInput)
    await userEvent.type(idInput, 'new-id')
    await userEvent.tab()

    expect(useEditorStore.getState().papers[0].id).toBe('new-id')
    confirmSpy.mockRestore()
  })

  it('does not ask for a paper with no recorded annotations', async () => {
    const paper = makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())
    paper.id = 'old-id'
    useEditorStore.setState({ papers: [paper] })
    render(<PapersEditor />)
    const confirmSpy = vi.spyOn(window, 'confirm')

    const idInput = screen.getByDisplayValue('old-id')
    await userEvent.clear(idInput)
    await userEvent.type(idInput, 'new-id')
    await userEvent.tab()

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(useEditorStore.getState().papers[0].id).toBe('new-id')
    confirmSpy.mockRestore()
  })
})

/**
 * jsdom has no native DragEvent, so `fireEvent.dragOver`'s event carries no
 * real `clientY` — `createEvent` builds a plain `Event`, which doesn't even
 * have the property. Forcing it on afterwards is enough to drive
 * `onDragOver`'s before/after split, which is what decides drop position.
 */
function dragOverAt(target: Element, dataTransfer: unknown, clientY: number) {
  const event = createEvent.dragOver(target, { dataTransfer })
  Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(target, event)
}

describe('PapersEditor: reorder papers by drag (REQ-EDT-90)', () => {
  function setup() {
    const a = makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())
    const b = makePaperFromPdf('b.pdf', 'b.pdf', undefined, new Set())
    const c = makePaperFromPdf('c.pdf', 'c.pdf', undefined, new Set())
    a.title = 'Paper A'
    b.title = 'Paper B'
    c.title = 'Paper C'
    useEditorStore.setState({ papers: [a, b, c] })
    const { container } = render(<PapersEditor />)
    let dragged = ''
    const dataTransfer = {
      setData: (_type: string, value: string) => {
        dragged = value
      },
      getData: () => dragged,
      effectAllowed: '',
      dropEffect: '',
    }
    return { container, dataTransfer }
  }

  it('dropping before the target row inserts it ahead of that row', () => {
    const { container, dataTransfer } = setup()
    const rowC = container.querySelector('#papers-row-2')!
    const rowA = container.querySelector('#papers-row-0')!

    fireEvent.dragStart(rowC, { dataTransfer })
    // Negative clientY sits above the (zero-height, in jsdom) target row's
    // midpoint, i.e. "before" it.
    dragOverAt(rowA, dataTransfer, -1)
    fireEvent.drop(rowA, { dataTransfer })

    const titles = useEditorStore.getState().papers.map((p) => p.title)
    expect(titles).toEqual(['Paper C', 'Paper A', 'Paper B'])
  })

  it('dropping after the target row inserts it behind that row', () => {
    const { container, dataTransfer } = setup()
    const rowC = container.querySelector('#papers-row-2')!
    const rowA = container.querySelector('#papers-row-0')!

    fireEvent.dragStart(rowC, { dataTransfer })
    dragOverAt(rowA, dataTransfer, 1)
    fireEvent.drop(rowA, { dataTransfer })

    const titles = useEditorStore.getState().papers.map((p) => p.title)
    expect(titles).toEqual(['Paper A', 'Paper C', 'Paper B'])
  })
})
