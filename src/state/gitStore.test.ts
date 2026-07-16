import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { GitPlatform, GitRun, PullStart } from '../git/types'

/**
 * `runPull`'s orchestration is the one place all the pieces of this feature
 * meet: the dirty guard, the pull classification, the parse boundary, the
 * merge, and the resolution dialog. The platform is stubbed (same shape as
 * `store.saveas.test.ts`), and `beginPullResult`/`finishPullResult` let each
 * test drive the fake git through exactly the branch it means to exercise.
 */

const SCHEMA = [{ name: 'Study Type', type: 'string' as const }]

function projectText(studyType: string | null): string {
  return JSON.stringify({
    version: 1,
    config: { schema: SCHEMA },
    papers: [
      {
        id: 'a',
        title: 'Paper A',
        authors: [],
        pdf: 'a.pdf',
        annotations: { 'Study Type': [{ value: studyType }] },
      },
    ],
  })
}

function projectTextWithSchema(schema: unknown[]): string {
  return JSON.stringify({ version: 1, config: { schema }, papers: [] })
}

const ok = (stdout = ''): GitRun => ({ ok: true, code: 0, stdout, stderr: '' })

let openedPaths: string[] = []
let abortCalls = 0
let finishCalls: { root: string; relPath: string; text: string }[] = []
let beginPullResult: PullStart = { kind: 'up-to-date' }
let finishPullResult: GitRun = ok()

const fakeGit: GitPlatform = {
  probe: async () => ({ available: true, version: 'git 2.43.0', error: '' }),
  pickCloneDir: async () => null,
  clone: async () => ({ ok: false, error: 'not used here' }),
  pickProjectIn: async () => null,
  info: async () => null,
  status: async () => ({ changes: [], diff: '', diffTruncated: false }),
  commit: async () => ok(),
  push: async () => ok(),
  beginPull: async () => beginPullResult,
  finishPull: async (root, relPath, text) => {
    finishCalls.push({ root, relPath, text })
    return finishPullResult
  },
  abortPull: async () => {
    abortCalls++
    return ok()
  },
}

const REPO = { root: '/repo', relPath: 'review.json', branch: 'main', upstream: 'origin/main', hasHead: true }

const mockPlatform = {
  kind: 'electron' as const,
  getOsInfo: () => null,
  getRecents: () => [] as RecentEntry[],
  rememberProject: () => {},
  forgetRecent: () => [] as RecentEntry[],
  checkRecents: async (entries: RecentEntry[]) => entries,
  openProject: async () => null,
  openRecent: async (id: string) => {
    openedPaths.push(id)
    return { text: projectText('reloaded'), handle: { kind: 'electron' as const, path: id }, name: 'x.json' }
  },
  saveProject: async (_text: string, handle: SaveHandle) => handle,
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: '' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  pickPdfFolder: async () => [],
  pickReferenceFile: async () => null,
  relativePdfPaths: async () => [],
  needsPdfFolderGrant: () => false,
  grantPdfFolderAccess: async () => {},
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
  getGit: () => fakeGit,
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')
const { useGitStore } = await import('./gitStore')

beforeEach(async () => {
  openedPaths = []
  abortCalls = 0
  finishCalls = []
  finishPullResult = ok()
  useStore.getState().loadFromText(projectText('mine'), { kind: 'electron', path: '/repo/review.json' }, 'review.json')
  useStore.setState({ dirty: false })
  useGitStore.setState({ probe: null, repo: { ...REPO }, clone: null, panel: null })
  await useGitStore.getState().openPanel()
})

describe('runPull', () => {
  it('up to date: a notice, no reload, no abort', async () => {
    beginPullResult = { kind: 'up-to-date' }
    await useGitStore.getState().runPull()
    expect(useGitStore.getState().panel?.notice).toMatch(/up to date/i)
    expect(openedPaths).toEqual([])
    expect(abortCalls).toBe(0)
  })

  it('dirty on disk: an error naming the paths, no abort', async () => {
    beginPullResult = { kind: 'dirty', paths: ['pdfs/a.pdf'] }
    await useGitStore.getState().runPull()
    expect(useGitStore.getState().panel?.error).toMatch(/pdfs\/a\.pdf/)
    expect(abortCalls).toBe(0)
  })

  it('no upstream: an error, no merge state', async () => {
    beginPullResult = { kind: 'no-upstream', branch: 'main' }
    await useGitStore.getState().runPull()
    const panel = useGitStore.getState().panel
    expect(panel?.error).toMatch(/no upstream/i)
    expect(panel?.merge).toBeNull()
  })

  it('fast-forward: the open project is re-opened', async () => {
    beginPullResult = { kind: 'fast-forwarded' }
    await useGitStore.getState().runPull()
    expect(openedPaths).toEqual(['/repo/review.json'])
    expect(useStore.getState().project?.papers[0].annotations['Study Type'][0].value).toBe('reloaded')
  })

  it('a conflict-free merge finishes on its own — finishPull is called, no dialog opens', async () => {
    beginPullResult = {
      kind: 'merge',
      ref: 'origin/main',
      base: projectText(null),
      ours: projectText('mine'),
      theirs: projectText(null), // unchanged on theirs' side — no conflict
    }
    await useGitStore.getState().runPull()
    expect(finishCalls).toHaveLength(1)
    const written = JSON.parse(finishCalls[0].text) as { papers: { annotations: Record<string, { value: unknown }[]> }[] }
    expect(written.papers[0].annotations['Study Type'][0].value).toBe('mine')
    expect(useGitStore.getState().panel?.merge).toBeNull()
  })

  it('a real conflict opens the resolution dialog — finishPull is not yet called', async () => {
    beginPullResult = {
      kind: 'merge',
      ref: 'origin/main',
      base: projectText(null),
      ours: projectText('mine'),
      theirs: projectText('theirs'),
    }
    await useGitStore.getState().runPull()
    const merge = useGitStore.getState().panel?.merge
    expect(merge).not.toBeNull()
    expect(merge?.conflicts).toHaveLength(1)
    expect(finishCalls).toHaveLength(0)
  })

  it('mergeProjects refusing a re-shaping change aborts the merge and names it', async () => {
    beginPullResult = {
      kind: 'merge',
      ref: 'origin/main',
      base: projectTextWithSchema(SCHEMA),
      ours: projectTextWithSchema([...SCHEMA, { name: 'Extra X', type: 'string' }]),
      theirs: projectTextWithSchema([...SCHEMA, { name: 'Extra Y', type: 'string' }]),
    }
    await useGitStore.getState().runPull()
    expect(abortCalls).toBe(1)
    expect(useGitStore.getState().panel?.error).toMatch(/schema/i)
    expect(finishCalls).toHaveLength(0)
  })

  it('an unparseable revision aborts the merge and writes nothing', async () => {
    beginPullResult = {
      kind: 'merge',
      ref: 'origin/main',
      base: projectText(null),
      ours: projectText('mine'),
      theirs: 'not valid json at all',
    }
    await useGitStore.getState().runPull()
    expect(abortCalls).toBe(1)
    expect(finishCalls).toHaveLength(0)
    expect(useGitStore.getState().panel?.error).toMatch(/origin\/main/)
  })

  it('refuses to run at all while the project has unsaved changes', async () => {
    useStore.setState({ dirty: true })
    let called = false
    beginPullResult = { kind: 'up-to-date' } // would flip `called` if reached
    const originalBeginPull = fakeGit.beginPull
    fakeGit.beginPull = async (...args) => {
      called = true
      return originalBeginPull(...args)
    }
    await useGitStore.getState().runPull()
    fakeGit.beginPull = originalBeginPull
    expect(called).toBe(false)
    expect(useGitStore.getState().panel?.error).toMatch(/save the project/i)
  })
})
