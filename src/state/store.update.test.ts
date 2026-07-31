import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'

if (typeof globalThis.localStorage === 'undefined') {
  const backing = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
    },
    configurable: true,
  })
}

/**
 * `checkForUpdate`'s native-update gate: `checkForNativeUpdate` (the call that
 * would actually let electron-updater start a download) must only fire once
 * the ordinary GitHub-API check has confirmed a newer version exists, and
 * never on macOS — see the plan's "two sources of truth stay separate" note
 * and electron/main.ts's darwin gate. This is the one piece of the self-update
 * feature that's plain logic rather than IPC/electron-updater plumbing, so
 * it's the one piece worth a unit test.
 */

const checkForNativeUpdate = vi.fn(async () => ({ supported: true }))

let osInfo: { platform: string; arch: string } | null = { platform: 'win32', arch: 'x64' }

const mockPlatform = {
  kind: 'electron' as const,
  getOsInfo: () => osInfo,
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
  checkForNativeUpdate,
  downloadNativeUpdate: async () => {},
  installNativeUpdate: async () => {},
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')

describe('checkForUpdate: native-update gate', () => {
  beforeEach(() => {
    checkForNativeUpdate.mockClear()
    osInfo = { platform: 'win32', arch: 'x64' }
    localStorage.clear()
    useStore.setState({ update: null })
  })

  it('does not call checkForNativeUpdate when no update is found', async () => {
    // fetchLatestRelease hits the real network unmocked in this repo's tests;
    // seed the cache directly instead, matching readUpdateCache's own shape,
    // so checkForUpdate takes the cached branch with release: null.
    localStorage.setItem('slr.updateCheck', JSON.stringify({ checkedAt: Date.now(), release: null }))
    await useStore.getState().checkForUpdate()
    expect(useStore.getState().update).toBeNull()
    expect(checkForNativeUpdate).not.toHaveBeenCalled()
  })

  it('calls checkForNativeUpdate on win/linux once a newer version is found', async () => {
    localStorage.setItem(
      'slr.updateCheck',
      JSON.stringify({ checkedAt: Date.now(), release: { latest: '99.0.0', url: 'https://example.com' } }),
    )
    await useStore.getState().checkForUpdate()
    expect(useStore.getState().update).not.toBeNull()
    expect(checkForNativeUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not call checkForNativeUpdate on macOS even when a newer version is found', async () => {
    osInfo = { platform: 'darwin', arch: 'arm64' }
    localStorage.setItem(
      'slr.updateCheck',
      JSON.stringify({ checkedAt: Date.now(), release: { latest: '99.0.0', url: 'https://example.com' } }),
    )
    await useStore.getState().checkForUpdate()
    expect(useStore.getState().update).not.toBeNull()
    expect(checkForNativeUpdate).not.toHaveBeenCalled()
  })
})
