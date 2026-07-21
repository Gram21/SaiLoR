import { useEffect } from 'react'
import { useStore } from '../state/store'
import { useEditorStore } from '../state/editorStore'

const INTERVAL_MS = 5 * 60 * 1000

/**
 * Periodically saves unsaved changes when the reviewer has opted in via the
 * Save menu (`autosaveEnabled`, see store.ts/settings.ts). Off by default —
 * this only ever runs after an explicit opt-in.
 *
 * Skipped while the project editor is open: `save()` here writes the
 * annotation `project` state, not the editor's own draft, and the two are
 * separate stores with their own dirty flags and their own save path.
 */
export function useAutosave() {
  const enabled = useStore((s) => s.autosaveEnabled)
  const hasProject = useStore((s) => !!s.project)
  const editorOpen = useEditorStore((s) => s.open)

  useEffect(() => {
    if (!enabled || !hasProject || editorOpen) return
    const id = setInterval(() => {
      const { dirty, busy, save } = useStore.getState()
      if (dirty && !busy) void save()
    }, INTERVAL_MS)
    return () => clearInterval(id)
  }, [enabled, hasProject, editorOpen])
}
