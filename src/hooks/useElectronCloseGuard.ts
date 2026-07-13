import { useEffect } from 'react'
import { useStore } from '../state/store'
import { isElectron } from '../platform/adapter'

/** The close-related slice of the preload bridge (Electron only). */
interface CloseBridge {
  setDirty(dirty: boolean): void
  onRequestSave(cb: () => void): void
  saveComplete(ok: boolean): void
}

/**
 * Coordinates a clean Electron quit:
 *  - keeps the main process informed of the unsaved-changes state, and
 *  - when the main process asks (after the user picks "Save" in the native
 *    close dialog), runs the save and reports success back.
 */
export function useElectronCloseGuard() {
  useEffect(() => {
    if (!isElectron()) return
    const slr = (window as unknown as { slr: CloseBridge }).slr

    // When main asks us to save before quitting, do it and report the outcome.
    slr.onRequestSave(async () => {
      const ok = await useStore.getState().save()
      slr.saveComplete(ok)
    })

    // Push the current + subsequent dirty state to the main process.
    slr.setDirty(useStore.getState().dirty)
    const unsub = useStore.subscribe((state, prev) => {
      if (state.dirty !== prev.dirty) slr.setDirty(state.dirty)
    })
    return unsub
  }, [])
}
