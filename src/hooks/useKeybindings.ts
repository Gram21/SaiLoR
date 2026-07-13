import { useEffect } from 'react'
import { useStore } from '../state/store'

/**
 * Global keyboard shortcuts:
 *  - Ctrl/Cmd+S         → Save
 *  - Ctrl/Cmd+Shift+S   → Save as
 *  - Alt+ArrowDown / ]  → next paper
 *  - Alt+ArrowUp   / [  → previous paper
 *
 * Copy/cut/paste/undo are left to the browser (and, in Electron, the Edit menu),
 * so they work natively inside inputs and the PDF text layer.
 */
export function useKeybindings() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey

      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        if (e.shiftKey) void useStore.getState().saveAs()
        else void useStore.getState().save()
        return
      }

      if (mod && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        void useStore.getState().openProject()
        return
      }

      if (e.key === 'F1') {
        e.preventDefault()
        useStore.getState().setHelpOpen(true)
        return
      }

      // Font scaling. Match both e.key and physical e.code (numpad, layouts where
      // '+' needs Shift). Override the browser/Electron native zoom.
      if (mod) {
        const inc = e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd'
        const dec = e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract'
        const reset = e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0'
        if (inc) {
          e.preventDefault()
          useStore.getState().increaseFont()
          return
        }
        if (dec) {
          e.preventDefault()
          useStore.getState().decreaseFont()
          return
        }
        if (reset) {
          e.preventDefault()
          useStore.getState().resetFont()
          return
        }
      }

      // Paper navigation. Skip when typing in a field unless Alt is held.
      const inField = isEditable(e.target)
      const nav = (dir: 1 | -1) => {
        e.preventDefault()
        stepPaper(dir)
      }
      if (e.altKey && e.key === 'ArrowDown') return nav(1)
      if (e.altKey && e.key === 'ArrowUp') return nav(-1)
      if (!inField && e.key === ']') return nav(1)
      if (!inField && e.key === '[') return nav(-1)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

function stepPaper(dir: 1 | -1) {
  const { project, currentPaperId, selectPaper } = useStore.getState()
  if (!project) return
  const idx = project.papers.findIndex((p) => p.id === currentPaperId)
  const next = idx + dir
  if (next >= 0 && next < project.papers.length) {
    selectPaper(project.papers[next].id)
  }
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}
