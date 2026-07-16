import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { PickedPdf, ProjectLocation } from '../platform/adapter'
import { pdfjs } from '../platform/pdfjs'

/**
 * `addPdfs` end to end against a **real** PDF, with nothing about pdfMeta
 * mocked — the one test that proves the whole chain (picker → `read()` bytes →
 * `extractPdfMeta` → the draft row) actually composes.
 *
 * Its sibling `editorStore.pdfs.test.ts` mocks `extractPdfMeta` to test this
 * wiring's *branches* cheaply, and `model/pdfMeta.test.ts` tests the heuristic
 * itself. Both of those passed while real papers extracted no abstract at all
 * (the heuristic stopped dead on the two-column layout every real paper uses),
 * which is precisely the seam neither could see. Hence this.
 *
 * The worker setup mirrors `model/pdfText.test.ts`'s, for the reason documented
 * there.
 */
const require = createRequire(import.meta.url)
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'),
).href

let picked: PickedPdf[] = []

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  pickPdfs: async () => picked,
  relativePdfPaths: async (pdfs: PickedPdf[]) => pdfs.map((p) => `pdfs/${p.name}`),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore } = await import('./editorStore')

const LOCATION: ProjectLocation = {
  handle: { kind: 'electron', path: '/reviews/my-slr.json' },
  name: 'my-slr.json',
  path: '/reviews/my-slr.json',
}

describe('addPdfs against a real PDF', () => {
  it('pre-fills title, authors and abstract, flagging the abstract as extracted', async () => {
    useEditorStore.setState({
      open: true,
      mode: 'new',
      location: LOCATION,
      screening: { reasons: ['Wrong topic'] },
      nodes: [],
      papers: [],
      dirty: false,
      notice: null,
      extracting: 0,
      justAdded: {},
    })

    picked = [
      {
        name: 'KeimKaplan_FromScatteredToStructured.pdf',
        path: '/reviews/pdfs/KeimKaplan_FromScatteredToStructured.pdf',
        read: async () =>
          new Uint8Array(readFileSync('samples/pdfs/KeimKaplan_FromScatteredToStructured.pdf')).buffer,
      },
    ]

    await useEditorStore.getState().addPdfs()

    const [paper] = useEditorStore.getState().papers
    expect(paper.title).toBe(
      'From Scattered to Structured: A Vision for Automating Architectural Knowledge Management',
    )
    expect(paper.authors).toBe('Jan Keim, Angelika Kaplan')
    // The real abstract, read out of a two-column layout, hyphenation healed.
    expect(paper.abstract).toMatch(/^Software architecture is inherently knowledge-centric\./)
    expect(paper.abstract).toMatch(/conversational knowledge access\.$/)
    expect(paper.abstract).toContain('The architectural knowledge is distributed')
    expect(paper.abstractFromPdf).toBe(true)
  })
})
