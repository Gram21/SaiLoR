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
 * would actually let the shell's updater start a download) must only fire once
 * the ordinary GitHub-API check has confirmed a newer version exists. The
 * shell then decides per bundle (src-tauri/src/update.rs).
 */

const checkForNativeUpdate = vi.fn(async () => ({ supported: true }))

let osInfo: { platform: string; arch: string } | null = { platform: 'win32', arch: 'x64' }

const mockPlatform = {
  kind: 'tauri' as const,
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
    checkForNativeUpdate.mockResolvedValue({ supported: true })
    osInfo = { platform: 'win32', arch: 'x64' }
    localStorage.clear()
    useStore.setState({ update: null, nativeUpdate: false })
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

  it('calls checkForNativeUpdate once a newer version is found', async () => {
    localStorage.setItem(
      'slr.updateCheck',
      JSON.stringify({ checkedAt: Date.now(), release: { latest: '99.0.0', url: 'https://example.com' } }),
    )
    await useStore.getState().checkForUpdate()
    expect(useStore.getState().update).not.toBeNull()
    expect(checkForNativeUpdate).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(useStore.getState().nativeUpdate).toBe(true))
  })

  it('lets the shell decide on every OS, macOS included', async () => {
    osInfo = { platform: 'darwin', arch: 'arm64' }
    localStorage.setItem(
      'slr.updateCheck',
      JSON.stringify({ checkedAt: Date.now(), release: { latest: '99.0.0', url: 'https://example.com' } }),
    )
    await useStore.getState().checkForUpdate()
    expect(checkForNativeUpdate).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(useStore.getState().nativeUpdate).toBe(true))
  })

  it('keeps the download link when the shell cannot self-update', async () => {
    checkForNativeUpdate.mockResolvedValue({ supported: false })
    localStorage.setItem(
      'slr.updateCheck',
      JSON.stringify({ checkedAt: Date.now(), release: { latest: '99.0.0', url: 'https://example.com' } }),
    )
    await useStore.getState().checkForUpdate()
    await Promise.resolve()
    expect(checkForNativeUpdate).toHaveBeenCalledTimes(1)
    expect(useStore.getState().nativeUpdate).toBe(false)
  })
})
