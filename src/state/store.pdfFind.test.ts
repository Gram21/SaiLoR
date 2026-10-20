import { describe, it, expect, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'

/**
 * REQ-LLM-460: `pdfFindRequest`/`requestPdfFind`/`clearPdfFindRequest` — the
 * store side of "jump from an AI evidence quote to the PDF". `PdfViewer`
 * consumes the request; this pins the state transitions it relies on.
 */

const mockPlatform = {
  kind: 'browser' as const,
  getOsInfo: () => null,
  getRecents: () => [] as RecentEntry[],
  rememberProject: () => {},
  forgetRecent: () => [] as RecentEntry[],
  checkRecents: async (entries: RecentEntry[]) => entries,
  openProject: async () => null,
  openRecent: async () => null,
  saveProject: async (_text: string, handle: SaveHandle) => handle,
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: '' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')

const schema = [{ name: 'A', type: 'string' as const, required: true }]

const twoPaperProject = JSON.stringify({
  version: 1,
  config: { schema },
  papers: [
    { id: 'p1', title: 'One', authors: [], pdf: 'a.pdf', annotations: {} },
    { id: 'p2', title: 'Two', authors: [], pdf: 'b.pdf', annotations: {} },
  ],
})

const st = () => useStore.getState()

describe('pdfFindRequest', () => {
  it('starts null, and requestPdfFind sets paperId/text with an incrementing nonce', () => {
    st().loadFromText(twoPaperProject, null, 'test.json')
    expect(st().pdfFindRequest).toBeNull()

    st().requestPdfFind('p1', 'some quoted passage')
    expect(st().pdfFindRequest).toEqual({ paperId: 'p1', text: 'some quoted passage', nonce: 1 })

    // A second request for the very same paper/quote still bumps the nonce —
    // PdfViewer keys its retry/timeout logic off it to notice a re-click.
    st().requestPdfFind('p1', 'some quoted passage')
    expect(st().pdfFindRequest?.nonce).toBe(2)
  })

  it('clearPdfFindRequest drops the pending request', () => {
    st().loadFromText(twoPaperProject, null, 'test.json')
    st().requestPdfFind('p2', 'evidence text')
    expect(st().pdfFindRequest).not.toBeNull()

    st().clearPdfFindRequest()
    expect(st().pdfFindRequest).toBeNull()
  })

  it('closing the project clears any pending request', () => {
    st().loadFromText(twoPaperProject, null, 'test.json')
    st().requestPdfFind('p1', 'evidence text')
    st().closeProject()
    expect(st().pdfFindRequest).toBeNull()
  })
})
