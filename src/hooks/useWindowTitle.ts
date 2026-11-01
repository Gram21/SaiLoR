import { useEffect } from 'react'
import { useStore } from '../state/store'
import { getPlatform } from '../platform'

/** "● Review - SaiLoR" for an open project with unsaved changes; "SaiLoR" with none open. */
export function windowTitle(name: string | null, dirty: boolean): string {
  if (name === null) return 'SaiLoR'
  return `${dirty ? '● ' : ''}${name} - SaiLoR`
}

/** Keeps the window title on the open project's title (else its file name) and unsaved state. */
export function useWindowTitle() {
  const name = useStore((s) => (s.project ? s.projectTitle || s.projectName || 'untitled' : null))
  const dirty = useStore((s) => s.dirty)
  useEffect(() => {
    getPlatform().setWindowTitle(windowTitle(name, dirty))
  }, [name, dirty])
}
