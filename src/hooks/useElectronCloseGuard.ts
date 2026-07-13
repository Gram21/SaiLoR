import { useEffect } from 'react'
import { useStore } from '../state/store'
import { isElectron } from '../platform/adapter'

/** The Electron-only slice of the preload bridge used for menu/close integration. */
interface IntegrationBridge {
  setDirty(dirty: boolean): void
  onRequestSave(cb: () => void): void
  saveComplete(ok: boolean): void
  onUndo(cb: () => void): void
  onRedo(cb: () => void): void
}

/**
 * Wires Electron menu/lifecycle integration:
 *  - keeps the main process informed of the unsaved-changes state,
 *  - runs a save when main asks (after "Save" in the native close dialog), and
 *  - routes the Edit-menu Undo/Redo to the annotation history.
 */
export function useElectronCloseGuard() {
  useEffect(() => {
    if (!isElectron()) return
    const slr = (window as unknown as { slr: IntegrationBridge }).slr

    // When main asks us to save before quitting, do it and report the outcome.
    slr.onRequestSave(async () => {
      const ok = await useStore.getState().save()
      slr.saveComplete(ok)
    })

    // Edit-menu Undo/Redo.
    slr.onUndo(() => useStore.getState().undo())
    slr.onRedo(() => useStore.getState().redo())

    // Push the current + subsequent dirty state to the main process.
    slr.setDirty(useStore.getState().dirty)
    const unsub = useStore.subscribe((state, prev) => {
      if (state.dirty !== prev.dirty) slr.setDirty(state.dirty)
    })
    return unsub
  }, [])
}
