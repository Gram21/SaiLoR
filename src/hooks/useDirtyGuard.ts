import { useEffect } from 'react'
import { useStore } from '../state/store'
import { isElectron } from '../platform/adapter'

/**
 * Warn before unloading the window (closing tab / navigating) with unsaved
 * changes. Browser only: in Electron a `beforeunload` that returns a value
 * silently cancels the quit with no dialog, so the desktop app instead handles
 * unsaved changes via a native dialog in the main process (see
 * useElectronCloseGuard + electron/main.ts).
 */
export function useDirtyGuard() {
  const dirty = useStore((s) => s.dirty)
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
