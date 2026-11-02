import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCloseGuard } from './useCloseGuard'
import { useStore } from '../state/store'
import { setBridge, type SlrBridge } from '../platform/bridge'

const tauriWindow = window as unknown as { __TAURI_INTERNALS__?: object }

afterEach(() => {
  setBridge(null)
  delete tauriWindow.__TAURI_INTERNALS__
})

describe('useCloseGuard', () => {
  it('routes File > Close project through the store close request', () => {
    const original = useStore.getState().requestCloseProject
    const requestCloseProject = vi.fn()
    useStore.setState({ requestCloseProject })
    let onClose: () => void = () => {}
    const bridge = {
      setDirty: vi.fn(),
      onRequestSave: vi.fn(),
      saveComplete: vi.fn(),
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      onNativeUpdateProgress: vi.fn(),
      onNativeUpdateDownloaded: vi.fn(),
      onNativeUpdateError: vi.fn(),
      onCloseProject: vi.fn((cb: () => void) => {
        onClose = cb
      }),
    }
    tauriWindow.__TAURI_INTERNALS__ = {}
    setBridge(bridge as unknown as SlrBridge)

    renderHook(() => useCloseGuard())
    onClose()

    expect(requestCloseProject).toHaveBeenCalledOnce()
    useStore.setState({ requestCloseProject: original })
  })
})
