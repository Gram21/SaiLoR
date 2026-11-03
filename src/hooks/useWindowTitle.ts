// [impl->req~ui-25~1]
import { useEffect } from 'react'
import { useStore } from '../state/store'
import { getPlatform } from '../platform'
import { t, useLanguage } from '../i18n'

/** "● Review - SaiLoR" for an open project with unsaved changes; "SaiLoR" with none open. */
export function windowTitle(name: string | null, dirty: boolean): string {
  if (name === null) return 'SaiLoR'
  return t(dirty ? 'app.windowTitle.unsaved' : 'app.windowTitle.clean', { name })
}

/** Keeps the window title on the open project's title (else its file name) and unsaved state. */
export function useWindowTitle() {
  const language = useLanguage()
  const name = useStore((s) => (s.project ? s.projectTitle || s.projectName || t('app.windowTitle.untitled') : null))
  const dirty = useStore((s) => s.dirty)
  useEffect(() => {
    getPlatform().setWindowTitle(windowTitle(name, dirty))
  }, [name, dirty, language])
}
