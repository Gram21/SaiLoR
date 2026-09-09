import { useEffect } from 'react'
import { useStore } from '../state/store'
import { useEditorStore } from '../state/editorStore'
import { isElectron } from '../platform/adapter'
import { DECISION_EXCLUDE, DECISION_INCLUDE } from '../screening/schema'

/**
 * Global keyboard shortcuts:
 *  - Ctrl/Cmd+S         → Save
 *  - Ctrl/Cmd+Shift+S   → Save as
 *  - Ctrl/Cmd+O         → Open
 *  - Ctrl/Cmd+Z         → Undo   (Electron routes this via its Edit menu)
 *  - Ctrl/Cmd+Shift+Z / Ctrl+Y → Redo
 *  - Ctrl/Cmd +/-/0        → PDF zoom in / out / reset
 *  - Ctrl/Cmd+Shift +/-/0  → App font size in / out / reset
 *  - Alt+ArrowDown / ]  → next paper
 *  - Alt+ArrowUp   / [  → previous paper
 *  - I / E / U          → screening: include / exclude / un-decide (screening
 *                          projects only, not while typing)
 *  - 1..9                → screening: exclude with the Nth configured reason
 *
 * While the project editor is open, save/undo/redo act on the draft, not the
 * project, and project-only bindings (open, paper nav, PDF zoom) are inert.
 *
 * Copy/cut/paste are left to the browser/Electron Edit menu so they still work
 * natively in inputs and the PDF text layer.
 */
export function useKeybindings() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const editing = useEditorStore.getState().open

      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        // A keyboard save never blurs the field, but the unsaved-edit confirm
        // guard hangs on `blur` — so `editorStore.save`/`saveAs` commit the
        // focused edit themselves first (see `commitFocusedEdit`).
        const editor = useEditorStore.getState()
        if (editing) {
          if (e.shiftKey) void editor.saveAs()
          else void editor.save()
        } else if (e.shiftKey) void useStore.getState().saveAs()
        else void useStore.getState().save()
        return
      }

      // Opening a project mid-edit would strand the draft, so ignore it there.
      if (mod && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        if (!editing) useStore.getState().requestOpenProject()
        return
      }

      // Undo/redo. In Electron the Edit-menu accelerators handle this (routed to
      // the right store via IPC), so skip it there to avoid double-triggering.
      if (mod && !isElectron() && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        const target = editing ? useEditorStore.getState() : useStore.getState()
        if (e.shiftKey) target.redo()
        else target.undo()
        return
      }
      if (mod && !isElectron() && !e.shiftKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        if (editing) useEditorStore.getState().redo()
        else useStore.getState().redo()
        return
      }

      if (e.key === 'F1') {
        e.preventDefault()
        // Blocked while another dialog is up: Escape closes both stacked dialogs
        // (losing reviewed AI proposals), and Help would render behind it anyway.
        // ReviewerPrompt is exempt (see BLOCKING_SURFACES_FOR_HELP) — it unmounts
        // instead of stacking, and F1 is its documented escape hatch.
        if (document.querySelector(BLOCKING_SURFACES_FOR_HELP)) return
        useStore.getState().setHelpOpen(true)
        return
      }

      // +/-/0 vary by Shift and keyboard layout, so match char or numpad code;
      // reset uses the digit-0 code (avoids e.g. German Shift+0 → '=').
      if (mod) {
        const reset = e.code === 'Digit0' || e.code === 'Numpad0'
        const inc =
          !reset && (e.key === '+' || e.key === '=' || e.key === '*' || e.code === 'NumpadAdd')
        const dec = !reset && (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract')
        if (inc || dec || reset) {
          e.preventDefault()
          const st = useStore.getState()
          if (e.shiftKey) {
            if (inc) st.increaseFont()
            else if (dec) st.decreaseFont()
            else st.resetFont()
          } else if (!editing) {
            // No PDF on screen while editing.
            if (inc) st.zoomInPdf()
            else if (dec) st.zoomOutPdf()
            else st.resetPdfZoom()
          }
          return
        }
      }

      if (editing) return
      // Skip bare-key bindings below while a modal is open — they'd otherwise
      // act invisibly on the paper behind the dialog (e.g. `3` excluding a
      // hidden paper while reading Help's shortcut table).
      if (aModalIsOpen()) return
      const inField = isEditable(e.target)

      // Screening hundreds of papers is faster as a keystroke than a click;
      // never while typing, same rule as `[`/`]` below.
      const st = useStore.getState()
      if (st.project?.screening && !inField && !mod && !e.altKey) {
        if (e.key === 'i' || e.key === 'I') {
          e.preventDefault()
          st.setScreeningDecision(DECISION_INCLUDE)
          return
        }
        if (e.key === 'e' || e.key === 'E') {
          e.preventDefault()
          st.setScreeningDecision(DECISION_EXCLUDE)
          return
        }
        if (e.key === 'u' || e.key === 'U') {
          e.preventDefault()
          st.setScreeningDecision(null)
          return
        }
        // Exclusion + reason is one decision, so one keystroke and one undo step.
        const n = Number(e.key)
        if (Number.isInteger(n) && n >= 1 && n <= 9) {
          const reason = st.project.screening.reasons[n - 1]
          if (reason) {
            e.preventDefault()
            st.setScreeningDecision(DECISION_EXCLUDE, reason)
          }
          return
        }
      }

      const nav = (dir: 1 | -1) => {
        e.preventDefault()
        stepPaper(dir)
      }
      // PaperList's onListKeyDown already handles this combo (and calls
      // preventDefault) when a row has DOM focus; re-running nav() here would
      // double-advance, so defer via e.defaultPrevented. Side effect: Alt+Arrow
      // is swallowed when ComboBox/ModelPicker's input has focus.
      if (e.altKey && e.key === 'ArrowDown' && !e.defaultPrevented) return nav(1)
      if (e.altKey && e.key === 'ArrowUp' && !e.defaultPrevented) return nav(-1)
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

  // Step through the DOM rows (filtered/search order), not the project's raw
  // order, so a search filter and [ / ] / Alt+Arrow agree on "next" — the
  // list's filter state lives locally, not in the store.
  const rows = document.querySelectorAll<HTMLElement>('.paper-list [role="option"][data-paper-id]')
  if (rows.length > 0) {
    const ids = Array.from(rows, (r) => r.dataset.paperId!)
    const idx = ids.indexOf(currentPaperId ?? '')
    const next = idx + dir
    if (next >= 0 && next < ids.length) selectPaper(ids[next])
    return
  }

  // Falls back to the project's own order when the list isn't mounted (the
  // sidebar is collapsed) — there is no visible filter to disagree with then.
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

/**
 * Anything blocking-shaped on screen? Bare-key bindings act invisibly on the
 * paper *behind* it. Covers `.modal-overlay` dialogs plus `ErrorPanel`'s
 * `.error-overlay` and an open `Dropdown`'s `.menu` — both missed by an
 * earlier `.modal-overlay`-only check.
 */
const BLOCKING_SURFACES = '.modal-overlay, .error-overlay, .menu'

// Same, but excludes ReviewerPrompt's overlay (opted out via its marker
// attribute) so F1 can open Help while that prompt is up.
const BLOCKING_SURFACES_FOR_HELP =
  '.modal-overlay:not([data-yields-to-help]), .error-overlay, .menu'

function aModalIsOpen(): boolean {
  return document.querySelector(BLOCKING_SURFACES) !== null
}
