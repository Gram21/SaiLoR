import { useEffect } from 'react'
import { useStore } from '../state/store'

/** Warn before unloading the window (closing tab / quitting) with unsaved changes. */
export function useDirtyGuard() {
  const dirty = useStore((s) => s.dirty)
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
