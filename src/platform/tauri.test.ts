import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { tauriBridge, TauriAdapter } from './tauri'
import { setBridge } from './bridge'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

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

    expect(invokeMock.mock.calls).toEqual([
      ['project:open', {}],
      ['project:openPath', { filePath: '/r/p.json' }],
      ['project:save', { filePath: '/r/p.json', metaText: null, files: [{ relPath: 'a', text: 'x' }] }],
      ['ollama:show', { baseUrl: 'http://h', model: 'm', numCtx: undefined }],
      ['local:modelInstall', { id: 'qwen' }],
      [
        'git:commitPartial',
        { root: '/r', relPath: 'p.json', committed: 'c', working: 'w', otherPaths: ['o'], message: 'msg', amend: true },
      ],
    ])
  })

  it('passes rejections through and swallows them for fire-and-forget sends', async () => {
    invokeMock.mockRejectedValue('command git:status not found')
    await expect(tauriBridge.gitStatus('/r')).rejects.toBe('command git:status not found')
    expect(tauriBridge.abortLlm('id-1')).toBeUndefined()
    expect(invokeMock).toHaveBeenLastCalledWith('llm:abort', { requestId: 'id-1' })
  })

  it('returns PDF bytes as a Uint8Array', async () => {
    invokeMock.mockResolvedValue([1, 2, 3])
    const bytes = await tauriBridge.readPdf('/a.pdf')
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect([...bytes]).toEqual([1, 2, 3])
    expect(invokeMock).toHaveBeenCalledWith('pdf:read', { filePath: '/a.pdf' })
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

  it('covers exactly the channels of electron/preload.ts', () => {
    const preload = readFileSync('electron/preload.ts', 'utf-8')
    const expected = new Set([...preload.matchAll(/ipcRenderer\.\w+\(\s*'([^']+)'/g)].map((m) => m[1]))

    const walk = (o: object) => {
      for (const v of Object.values(o)) {
        if (typeof v === 'function') v(() => {})
        else if (v && typeof v === 'object') walk(v)
      }
    }
    walk(tauriBridge)
    const mapped = new Set([...invokeMock.mock.calls, ...listenMock.mock.calls].map((c) => c[0]))

    expect(expected.size).toBeGreaterThan(90)
    expect([...mapped].sort()).toEqual([...expected].sort())
  })
})

describe('TauriAdapter', () => {
  it('routes the shared adapter logic through the Tauri bridge', async () => {
    invokeMock.mockResolvedValue({ porcelain: ' M a.json\n', diff: '' })
    const status = await new TauriAdapter().getGit().status('/r')
    expect(invokeMock).toHaveBeenCalledWith('git:status', { root: '/r' })
    expect(status.changes).toHaveLength(1)
  })
})
