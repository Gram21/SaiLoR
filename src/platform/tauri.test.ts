import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { tauriBridge, TauriAdapter, assembleProject } from './tauri'
import { setBridge } from './bridge'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
const setTitle = vi.fn(() => Promise.resolve())
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTitle }) }))

const invokeMock = vi.mocked(invoke)
const listenMock = vi.mocked(listen)

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined)
  listenMock.mockReset().mockImplementation(() => Promise.resolve(vi.fn()))
})

afterEach(() => setBridge(null))

describe('tauriBridge', () => {
  it('maps calls to the preload channel with named args', async () => {
    await tauriBridge.openProject()
    await tauriBridge.openPath('/r/p.json')
    await tauriBridge.saveProject('/r/p.json', null, [{ relPath: 'a', text: 'x' }])
    await tauriBridge.ollama.show('http://h', 'm')
    await tauriBridge.local.modelInstall('qwen')
    await tauriBridge.gitCommitPartial('/r', 'p.json', 'c' as never, 'w' as never, ['o'], 'msg', true)
    await tauriBridge.annotationsDirUsers('/r/p.json', 'ann', ['p1'], true)
    await tauriBridge.moveAnnotationsDir('/r/p.json', 'ann')
    await tauriBridge.sharedAnnotations('/r/p.json')
    await tauriBridge.splitAnnotations('/r/p.json', { folders: { '/r/p.json': 'a' }, rows: [] })
    await tauriBridge.pickReferenceFile()

    expect(invokeMock.mock.calls).toEqual([
      ['project_open', {}],
      ['project_open_path', { filePath: '/r/p.json' }],
      ['project_save', { filePath: '/r/p.json', metaText: null, files: [{ relPath: 'a', text: 'x' }] }],
      ['ollama_show', { baseUrl: 'http://h', model: 'm', numCtx: undefined }],
      ['local_model_install', { id: 'qwen' }],
      [
        'git_commit_partial',
        { root: '/r', relPath: 'p.json', committed: 'c', working: 'w', otherPaths: ['o'], message: 'msg', amend: true },
      ],
      ['project_annotations_dir_users', { projectPath: '/r/p.json', folder: 'ann', paperIds: ['p1'], screening: true }],
      ['project_move_annotations_dir', { projectPath: '/r/p.json', folder: 'ann' }],
      ['project_shared_annotations', { projectPath: '/r/p.json' }],
      ['project_split_annotations', { projectPath: '/r/p.json', plan: { folders: { '/r/p.json': 'a' }, rows: [] } }],
      ['reference_pick', {}],
    ])
  })

  it('passes rejections through and swallows them for fire-and-forget sends', async () => {
    invokeMock.mockRejectedValue('command git:status not found')
    await expect(tauriBridge.gitStatus('/r')).rejects.toBe('command git:status not found')
    expect(tauriBridge.abortLlm('id-1')).toBeUndefined()
    expect(invokeMock).toHaveBeenLastCalledWith('llm_abort', { requestId: 'id-1' })
  })

  it('returns PDF bytes as a Uint8Array', async () => {
    invokeMock.mockResolvedValue([1, 2, 3])
    const bytes = await tauriBridge.readPdf('/a.pdf')
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect([...bytes]).toEqual([1, 2, 3])
    expect(invokeMock).toHaveBeenCalledWith('pdf_read', { filePath: '/a.pdf' })
  })

  it('delivers event payloads and unsubscribes', async () => {
    const unlisten = vi.fn()
    listenMock.mockResolvedValue(unlisten)
    const cb = vi.fn()
    const off = tauriBridge.local.onProgress(cb)
    const handler = listenMock.mock.calls[0][1]
    handler({ event: 'local:progress', id: 1, payload: { pct: 5 } })
    expect(listenMock.mock.calls[0][0]).toBe('local:progress')
    expect(cb).toHaveBeenCalledWith({ pct: 5 })
    off()
    await Promise.resolve()
    expect(unlisten).toHaveBeenCalled()
  })

  it('keeps a single listener for on* registrations, like removeAllListeners in preload', async () => {
    const first = vi.fn()
    listenMock.mockResolvedValueOnce(first)
    tauriBridge.onUndo(() => {})
    tauriBridge.onUndo(() => {})
    await Promise.resolve()
    expect(first).toHaveBeenCalled()
    expect(listenMock.mock.calls.map((c) => c[0])).toEqual(['app:undo', 'app:undo'])
  })

  it('sets the window title through the window API and swallows a refusal', async () => {
    tauriBridge.setWindowTitle('Review - SaiLoR')
    expect(setTitle).toHaveBeenLastCalledWith('Review - SaiLoR')
    setTitle.mockReturnValueOnce(Promise.reject(new Error('not allowed')))
    expect(() => tauriBridge.setWindowTitle('SaiLoR')).not.toThrow()
    await Promise.resolve()
  })

  it('allows the window title call in the capability', () => {
    const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf-8'))
    expect(capability.permissions).toContain('core:window:allow-set-title')
  })

  it('invokes exactly the commands main.rs registers', () => {
    const main = readFileSync('src-tauri/src/main.rs', 'utf-8')
    const handler = main.slice(main.indexOf('generate_handler!['))
    const registered = [...handler.slice(0, handler.indexOf('])')).matchAll(/^\s+\w+::(\w+),$/gm)].map((m) => m[1])

    const walk = (o: object) => {
      for (const v of Object.values(o)) {
        if (typeof v === 'function') v(() => {})
        else if (v && typeof v === 'object') walk(v)
      }
    }
    walk(tauriBridge)
    const invoked = new Set(invokeMock.mock.calls.map((c) => c[0]))

    expect(registered.length).toBeGreaterThan(90)
    expect([...invoked].sort()).toEqual([...new Set(registered)].sort())
  })
})

describe('project assembly', () => {
  const meta = (screening = false) =>
    JSON.stringify({ config: { screening }, papers: [{ id: 'p1' }, { id: 'p2' }] })
  const f = (relPath: string, value: unknown) => ({ relPath, text: JSON.stringify(value) })

  it('returns a legacy project text unchanged', () => {
    const text = '{"papers":[{"id":"p1","annotations":{}}]}'
    expect(assembleProject({ text, files: [] })).toBe(text)
  })

  it('assembles own files, reports corrupt ones and skips foreign ones', () => {
    const corrupt: string[] = []
    const text = assembleProject(
      {
        text: meta(),
        files: [
          f('p1/consolidated.json', { annotations: { q: 1 }, finished: true }),
          f('p1/reviewer-2.json', { annotations: { q: 2 } }),
          f('p1/marks-consolidated.json', { marks: ['c'] }),
          f('p1/marks-2.json', { marks: ['r'] }),
          f('p1/screening-1.json', { annotations: { q: 9 } }),
          { relPath: 'p2/reviewer-1.json', text: '{oops' },
        ],
      },
      corrupt,
    )
    const p = JSON.parse(text).papers
    expect(p[0]).toMatchObject({
      annotations: { q: 1 },
      finished: true,
      reviews: { 2: { q: 2 } },
      marks: ['c'],
      reviewMarks: { 2: ['r'] },
    })
    expect(p[1]).toMatchObject({ annotations: {} })
    expect(p[1].reviews).toBeUndefined()
    expect(corrupt).toEqual(['p2/reviewer-1.json'])
  })

  it("reads a screening project's old highlight files unless an annotation sibling lists the paper", () => {
    const files = [f('p1/marks-1.json', { marks: ['old'] }), f('p1/screening-marks-1.json', { marks: ['own'] }), f('p2/marks-1.json', { marks: ['old'] })]
    const sibling = { name: 'a.json', text: JSON.stringify({ papers: [{ id: 'p2' }] }) }
    const p = JSON.parse(assembleProject({ text: meta(true), files, siblings: [sibling] })).papers
    expect(p[0].reviewMarks).toEqual({ 1: ['own'] })
    expect(p[1].reviewMarks).toBeUndefined()
  })

  it('gives the renderer the whole-project shapes', async () => {
    const raw = { text: meta(), files: [f('p1/consolidated.json', { annotations: { q: 1 } })] }
    const whole = assembleProject(raw)
    invokeMock.mockResolvedValueOnce({ path: '/r/p.json', ...raw, files: [...raw.files, { relPath: 'p2/consolidated.json', text: 'x' }], siblings: [] })
    expect(await tauriBridge.openPath('/r/p.json')).toEqual({ path: '/r/p.json', text: whole, corrupt: ['p2/consolidated.json'] })
    invokeMock.mockResolvedValueOnce(null)
    expect(await tauriBridge.openProject()).toBeNull()
    invokeMock.mockResolvedValueOnce(raw)
    expect(await tauriBridge.gitHeadContent('/r', 'p.json')).toBe(whole)
    invokeMock.mockResolvedValueOnce(null)
    expect(await tauriBridge.gitWorkingContent('/r', 'p.json')).toBeNull()
    invokeMock.mockResolvedValueOnce({ kind: 'texts', head: raw, parent: raw })
    expect(await tauriBridge.gitLogDiff('/r', 'p.json', 'abc')).toEqual({ kind: 'texts', head: whole, parent: whole })
    invokeMock.mockResolvedValueOnce({ kind: 'merge', ref: 'origin/main', base: null, ours: raw, theirs: raw })
    expect(await tauriBridge.gitPullBegin('/r', 'p.json')).toEqual({ kind: 'merge', ref: 'origin/main', base: null, ours: whole, theirs: whole })
    invokeMock.mockResolvedValueOnce({ kind: 'merge', sourceBranch: 'a', base: raw, ours: { ...raw, path: '/r/p.json', siblings: [] }, theirs: raw })
    expect(await tauriBridge.gitBranchSwitchBegin('/r', 'p.json', 'b')).toEqual({ kind: 'merge', sourceBranch: 'a', base: whole, ours: whole, theirs: whole })
    invokeMock.mockResolvedValueOnce({ kind: 'dirty', paths: ['x'] })
    expect(await tauriBridge.gitMergeBegin('/r', 'p.json', 'b')).toEqual({ kind: 'dirty', paths: ['x'] })
    invokeMock.mockResolvedValueOnce({ name: 's.json', path: '/r/s.json', ...raw, siblings: [] })
    expect(await tauriBridge.screeningSource('/r/p.json')).toEqual({ name: 's.json', text: whole })
    invokeMock.mockResolvedValueOnce(null)
    expect(await tauriBridge.screeningSource('/r/p.json')).toBeNull()
  })
})

describe('TauriAdapter', () => {
  it('routes the shared adapter logic through the Tauri bridge', async () => {
    invokeMock.mockResolvedValue({ porcelain: ' M a.json\n', diff: '' })
    const status = await new TauriAdapter().getGit().status('/r')
    expect(invokeMock).toHaveBeenCalledWith('git_status', { root: '/r' })
    expect(status.changes).toHaveLength(1)
  })
})
