import { useEffect } from 'react'
import { useStore } from '../state/store'
import { useEditorStore } from '../state/editorStore'
import { isElectron } from '../platform/adapter'

/** The Electron-only slice of the preload bridge used for menu/close integration. */
interface IntegrationBridge {
  setDirty(dirty: boolean): void
  onRequestSave(cb: () => void): void
  saveComplete(ok: boolean): void
  onUndo(cb: () => void): void
  onRedo(cb: () => void): void
  onNativeUpdateProgress(cb: (p: { percent: number }) => void): void
  onNativeUpdateDownloaded(cb: () => void): void
  onNativeUpdateError(cb: (message: string) => void): void
}

/**
 * Wires Electron menu/lifecycle integration:
 *  - keeps the main process informed of the unsaved-changes state,
 *  - runs a save when main asks (after "Save" in the native close dialog), and
 *  - routes the Edit-menu Undo/Redo to the history that is actually on screen.
 *
 * The project editor has its own draft + history, so while it is open every one
 * of these targets the editor rather than the annotation project.
 */
export function useElectronCloseGuard() {
  useEffect(() => {
    if (!isElectron()) return
    const slr = (window as unknown as { slr: IntegrationBridge }).slr

    const editing = () => useEditorStore.getState().open

    // When main asks us to save before quitting, save whatever is on screen.
    slr.onRequestSave(async () => {
      const ok = editing()
        ? await useEditorStore.getState().save()
        : await useStore.getState().save()
      slr.saveComplete(ok)
    })

    // Edit-menu Undo/Redo.
    slr.onUndo(() => (editing() ? useEditorStore.getState().undo() : useStore.getState().undo()))
    slr.onRedo(() => (editing() ? useEditorStore.getState().redo() : useStore.getState().redo()))

    // Self-update progress (win/linux only — a no-op on mac, see electron/main.ts).
    slr.onNativeUpdateProgress((p) => useStore.getState().noteUpdateProgress(p.percent))
    slr.onNativeUpdateDownloaded(() => useStore.getState().noteUpdateDownloaded())
    slr.onNativeUpdateError((message) => useStore.getState().noteUpdateError(message))

    // Either an unsaved draft or unsaved annotations should block a clean quit.
    const isDirty = () => useStore.getState().dirty || useEditorStore.getState().dirty
    let lastDirty = isDirty()
    slr.setDirty(lastDirty)
    const push = () => {
      const dirty = isDirty()
      if (dirty !== lastDirty) {
        lastDirty = dirty
        slr.setDirty(dirty)
      }
    }
    const unsubStore = useStore.subscribe(push)
    const unsubEditor = useEditorStore.subscribe(push)
    return () => {
      unsubStore()
      unsubEditor()
    }
  }, [])
}
