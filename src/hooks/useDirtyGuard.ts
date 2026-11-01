import { useEffect } from 'react'
import { useStore } from '../state/store'
import { useEditorStore } from '../state/editorStore'
/**
 * Warn before unloading the window (closing tab / navigating) with unsaved
 * changes. The native close dialog for quitting the app lives in Rust (see
 * useCloseGuard + src-tauri/src/close.rs).
 */
export function useDirtyGuard() {
  // An unsaved schema draft counts, exactly as it does for the quit guard's
  // `isDirty()`: it is no less lost on a tab close than an unsaved
  // annotation is, and the editor is the only thing on screen while it is open.
  const projectDirty = useStore((s) => s.dirty)
  const draftDirty = useEditorStore((s) => s.dirty)
  const dirty = projectDirty || draftDirty
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
}
