import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SaveHandle } from '../platform/adapter'
import { t } from '../i18n'

const config = { schema: [{ name: 'Relevant', type: 'boolean' }] }
const text = (value: boolean) =>
  JSON.stringify({
    version: 1,
    config,
    papers: [{ id: 'p0', title: 'P', authors: [], pdf: 'p0.pdf', annotations: { Relevant: [{ value }] } }],
  })

let onDisk = text(true)
let finishUndo: (() => void) | null = null
const handle: SaveHandle = { kind: 'electron', path: '/r/project.json' }

const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  openRecent: async () => ({ text: onDisk, handle, name: 'project.json', corruptFiles: [] }),
  getGit: () => ({
    undoMerge: () =>
      new Promise((r) => {
        finishUndo = () => {
          onDisk = text(false)
          r({ ok: true, code: 0, stdout: '', stderr: '' })
        }
      }),
    status: async () => ({ files: [] }),
  }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')
const { useGitStore } = await import('./gitStore')
const st = () => useStore.getState()
const relevant = () => st().project!.papers[0].annotations.Relevant[0].value

// [utest->req~git-610~1]
describe('a git operation that rewrites the files while the project is edited', () => {
  beforeEach(async () => {
    onDisk = text(true)
    finishUndo = null
    await st().openRecent(handle.path!)
    st().selectPaper('p0')
    useStore.setState((s) => {
      s.loadError = null
    })
    useGitStore.setState({
      repo: { root: '/r', relPath: 'project.json', branch: 'main', upstream: null, hasHead: true, behind: null },
      panel: { phase: 'idle', error: null, notice: null },
    } as never)
  })

  it('keeps an edit made during Undo merge and says the files were not loaded', async () => {
    const run = useGitStore.getState().runUndoMerge()
    await vi.waitFor(() => expect(finishUndo).not.toBeNull())
    st().setFieldValue([], 'Relevant', 0, null)
    finishUndo!()
    await run

    expect(relevant()).toBeNull()
    expect(st().dirty).toBe(true)
    expect(st().loadError?.message).toBe(t('store.loadError.resyncKeptEdits'))
  })

  it('loads the rewritten files when nothing was edited', async () => {
    const run = useGitStore.getState().runUndoMerge()
    await vi.waitFor(() => expect(finishUndo).not.toBeNull())
    finishUndo!()
    await run

    expect(relevant()).toBe(false)
    expect(st().loadError).toBeNull()
  })
})
