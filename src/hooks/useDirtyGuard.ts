import { useEffect } from 'react'
import { useStore } from '../state/store'
import { useEditorStore } from '../state/editorStore'
import { isElectron } from '../platform/adapter'

/**
 * Warn before unloading the window (closing tab / navigating) with unsaved
 * changes. Browser only: in Electron a `beforeunload` that returns a value
 * silently cancels the quit with no dialog, so the desktop app instead handles
 * unsaved changes via a native dialog in the main process (see
 * useElectronCloseGuard + electron/main.ts).
 */
export function useDirtyGuard() {
  // An unsaved schema draft counts, exactly as it does for the Electron quit
  // guard's `isDirty()` — it is no less lost on a tab close than an unsaved
  // annotation is, and the editor is the only thing on screen while it is open.
  const projectDirty = useStore((s) => s.dirty)
  const draftDirty = useEditorStore((s) => s.dirty)
  const dirty = projectDirty || draftDirty
  useEffect(() => {
    if (!dirty || isElectron()) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
}
