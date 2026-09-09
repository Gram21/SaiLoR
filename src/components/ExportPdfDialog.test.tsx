import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

let mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  absolutePdfPaths: async (_pdfPaths: string[], _from: unknown) => ['/fake/paper.pdf'] as (string | undefined)[],
  pickPdfExportPath: async (_name: string) => '/fake/paper-annotated.pdf' as string | null,
  embedPdfAnnotations: async (_path: string, _marks: unknown[], _target: unknown) =>
    ({ ok: true, path: '/fake/paper-annotated.pdf' }) as
      | { ok: true; path: string }
      | { ok: false; error: string },
}

vi.mock('../platform', () => ({
  getPlatform: () => mockPlatform,
}))

const { useStore } = await import('../state/store')
const { ExportPdfDialog } = await import('./ExportPdfDialog')

const st = () => useStore.getState()

function projectJson() {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
    papers: [{ id: 'p1', title: 'A Paper', authors: ['Jane Doe'], pdf: 'a.pdf', annotations: {} }],
  })
}

beforeEach(() => {
  mockPlatform = {
    kind: 'electron',
    getRecents: () => [],
    rememberProject: () => {},
    forgetRecent: () => [],
    checkRecents: async (e: unknown[]) => e,
    getOsInfo: () => null,
    absolutePdfPaths: async () => ['/fake/paper.pdf'],
    pickPdfExportPath: async () => '/fake/paper-annotated.pdf',
    embedPdfAnnotations: async () => ({ ok: true, path: '/fake/paper-annotated.pdf' }),
  }
  st().loadFromText(projectJson(), null, 'test.json')
  st().selectPaper('p1')
})

describe('ExportPdfDialog: exporting marks into a PDF (REQ-PDF-160)', () => {
  it('shows a resolve error and keeps Export disabled when the project has no saved path', async () => {
    useStore.setState({ exportPdfOpen: true, saveHandle: null })
    render(<ExportPdfDialog />)

    expect(
      await screen.findByText(/project has not been saved yet, so there is no folder to resolve/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
  })

  it('exports to a new file and reports success', async () => {
    const embed = vi.fn(async () => ({ ok: true as const, path: '/fake/paper-annotated.pdf' }))
    mockPlatform.embedPdfAnnotations = embed
    useStore.setState({
      exportPdfOpen: true,
      saveHandle: { kind: 'electron', path: '/fake/project.json' },
    })
    render(<ExportPdfDialog />)

    const exportBtn = await screen.findByRole('button', { name: 'Export' })
    await waitFor(() => expect(exportBtn).toBeEnabled())

    await userEvent.click(exportBtn)

    await waitFor(() =>
      expect(embed).toHaveBeenCalledWith('/fake/paper.pdf', st().currentPdfMarks(), {
        newPath: '/fake/paper-annotated.pdf',
      }),
    )
    expect(await screen.findByText(/Exported to \/fake\/paper-annotated\.pdf/)).toBeInTheDocument()
  })

  it('shows the export error instead of closing when embedding fails', async () => {
    mockPlatform.embedPdfAnnotations = async () => ({ ok: false as const, error: 'disk full' })
    useStore.setState({
      exportPdfOpen: true,
      saveHandle: { kind: 'electron', path: '/fake/project.json' },
    })
    render(<ExportPdfDialog />)

    const exportBtn = await screen.findByRole('button', { name: 'Export' })
    await waitFor(() => expect(exportBtn).toBeEnabled())

    await userEvent.click(exportBtn)

    expect(await screen.findByText('disk full')).toBeInTheDocument()
  })

  it('exports into the original file with target "original" when that option is picked', async () => {
    const embed = vi.fn(async () => ({ ok: true as const, path: '/fake/paper.pdf' }))
    mockPlatform.embedPdfAnnotations = embed
    useStore.setState({
      exportPdfOpen: true,
      saveHandle: { kind: 'electron', path: '/fake/project.json' },
    })
    render(<ExportPdfDialog />)

    const exportBtn = await screen.findByRole('button', { name: 'Export' })
    await waitFor(() => expect(exportBtn).toBeEnabled())

    await userEvent.click(screen.getByRole('radio', { name: 'Save into the original PDF file' }))
    await userEvent.click(exportBtn)

    await waitFor(() =>
      expect(embed).toHaveBeenCalledWith('/fake/paper.pdf', st().currentPdfMarks(), 'original'),
    )
  })
})
