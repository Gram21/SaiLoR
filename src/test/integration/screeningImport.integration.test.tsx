import '@testing-library/jest-dom/vitest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SaveHandle, OpenedProject, ProjectLocation } from '../../platform/adapter'

/**
 * A fourth integration test, same real-components style as the others in
 * this directory — covers the screening workflow: real include/exclude
 * decisions through `ScreeningPanel`, then converting the screened project
 * into a new annotation project through `startFromScreening` →
 * `ScreeningImportDialog` → `resolveScreeningImport`, exactly the
 * "New from screening…" button's own flow, minus the native file dialogs
 * (`openProject`/`siblingProjectLocation` are backed by real fs here instead).
 */

let repoDir: string
let projectJsonPath: string

const fakePlatform = {
  kind: 'electron' as const,
  getOsInfo: () => null,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (entries: unknown) => entries,
  // Real fs read, standing in for the native "Open" dialog — mirrors how
  // the other tests' `saveProject` writes for real instead of stubbing.
  openProject: async (): Promise<OpenedProject | null> => ({
    text: readFileSync(projectJsonPath, 'utf-8'),
    handle: { kind: 'electron', path: projectJsonPath },
    name: 'screening.json',
  }),
  openRecent: async () => null,
  saveProject: async (text: string, handle: SaveHandle) => {
    writeFileSync(handle.path!, text)
    return handle
  },
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: 'blob:fake-pdf-source' }),
  needsPdfFolderGrant: () => false,
  grantPdfFolderAccess: async () => {},
  // A real sibling path next to the screening JSON — no dialog needed, same
  // as the real Electron adapter's own no-prompt implementation.
  siblingProjectLocation: async (_source: SaveHandle, fileName: string): Promise<ProjectLocation> => ({
    handle: { kind: 'electron', path: join(repoDir, fileName) },
    name: fileName,
    path: join(repoDir, fileName),
  }),
  pickProjectLocation: async () => null,
  absolutePdfPaths: async (paths: string[]) => paths.map(() => undefined),
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
  getGit: () => null,
}

vi.mock('../../platform', () => ({ getPlatform: () => fakePlatform }))

const { useStore } = await import('../../state/store')
const { useEditorStore } = await import('../../state/editorStore')
const { ScreeningPanel } = await import('../../components/ScreeningPanel')
const { ScreeningImportDialog } = await import('../../components/ScreeningImportDialog')

function screeningProjectJson() {
  return JSON.stringify({
    version: 1,
    config: { screening: { reasons: ['Wrong topic', 'Not empirical'] } },
    papers: [
      { id: 'p1', title: 'Paper One', authors: ['A. One'], abstract: 'Abstract one.' },
      { id: 'p2', title: 'Paper Two', authors: ['B. Two'], abstract: 'Abstract two.' },
      { id: 'p3', title: 'Paper Three', authors: [], abstract: 'Abstract three.' },
    ],
  })
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'sailor-integration-screening-'))
  projectJsonPath = join(repoDir, 'screening.json')
  writeFileSync(projectJsonPath, screeningProjectJson())
})

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

describe('screening decisions and conversion to a full annotation project', () => {
  it('screens papers through the real panel, then imports the survivors via startFromScreening', async () => {
    const user = userEvent.setup()

    useStore
      .getState()
      .loadFromText(readFileSync(projectJsonPath, 'utf-8'), { kind: 'electron', path: projectJsonPath }, 'screening.json')

    // ---- Phase 1: real include/exclude decisions -------------------------
    useStore.getState().selectPaper('p1')
    render(<ScreeningPanel />)
    await user.click(screen.getByTitle('Include this paper (shortcut: I)'))
    cleanup()

    useStore.getState().selectPaper('p2')
    render(<ScreeningPanel />)
    await user.click(screen.getByTitle('Exclude this paper (shortcut: E)'))
    cleanup()
    // A decision auto-advances `currentPaperId` to the next undecided paper
    // (see `setScreeningDecision`'s own doc comment) — re-select p2 before
    // setting its reason, or the write below would land on whatever paper
    // it advanced to instead.
    useStore.getState().selectPaper('p2')
    // The reason ComboBox is a portaled filter-as-you-type menu — setting it
    // directly through the same store action a real pick commits to is a
    // deliberate simplification; the decision itself (the interesting
    // screening action) went through the real button above.
    useStore.getState().setScreeningReason('Wrong topic')

    // p3 stays undecided (never selected, never given a decision).

    await useStore.getState().save()
    const savedRaw = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as { papers: Array<{ id: string }> }
    expect(savedRaw.papers).toHaveLength(3)

    // ---- Phase 2: convert to a full annotation project --------------------
    await useEditorStore.getState().startFromScreening()
    const draft = useEditorStore.getState().screeningImport
    expect(draft?.included).toHaveLength(1)
    expect(draft?.undecided).toHaveLength(1)
    expect(draft?.excludedCount).toBe(1)
    expect(draft?.excludedByReason).toEqual({ 'Wrong topic': 1 })

    render(<ScreeningImportDialog />)
    await screen.findByText('3 papers in this screening project.')
    await user.click(screen.getByRole('button', { name: /^Import 2 papers$/ }))

    // ---- Verify: a new annotation-project draft, seeded with the survivors
    const papers = useEditorStore.getState().papers
    // "-2": a `target: 'start'` draft shares the source's own directory
    // (and thus its `annotations/` folder), so a carried id verbatim-equal
    // to a source paper's id is renamed to avoid colliding with it — see
    // `startFromScreening`'s own doc comment on `taken`.
    expect(papers.map((p) => p.id).sort()).toEqual(['p1-2', 'p3-2']) // included + undecided, not p2 (excluded)
    expect(papers.map((p) => p.title).sort()).toEqual(['Paper One', 'Paper Three'])
    expect(useEditorStore.getState().provenance).toMatchObject({
      kind: 'screening-import',
      source: { file: 'screening.json' },
      counts: { included: 1, undecided: 1, excluded: 1, carried: 2 },
    })
    expect(useEditorStore.getState().screening).toBeNull() // "annotation" kind was the default choice
    expect(useEditorStore.getState().location?.path).toBe(join(repoDir, 'screening-annotation.json'))
  })
})
