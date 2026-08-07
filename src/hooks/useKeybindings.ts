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
 * While the project editor is open, save and undo/redo drive the *draft* rather
 * than the annotation project, and the project-specific bindings (open, paper
 * navigation, PDF zoom) are inert — there is no project on screen to act on.
 *
 * Copy/cut/paste are left to the browser (and, in Electron, the Edit menu), so
 * they work natively inside inputs and the PDF text layer.
 */
export function useKeybindings() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const editing = useEditorStore.getState().open

      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        // The field-rename confirm-before-you-lose-answers guard (schema field
        // name, screening reason label) hangs on `blur`, and a keyboard save
        // never moves focus on its own. `editorStore`'s `save`/`saveAs` commit
        // the focused edit themselves before doing anything else — see
        // `commitFocusedEdit` there — so every way to save the project editor
        // (this shortcut, the toolbar Save button, and the native quit
        // dialog's Save) shares the one guard instead of each needing its own
        // copy of this comment.
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
        // Not while another dialog is up. Every dialog listens for Escape on
        // `document` and none stops propagation, so with Help stacked on top a
        // single Escape closes both — and closing the AI dialog discards a
        // reviewed set of proposals, which costs the reviewer the API call as
        // well as the reading. Help is also mounted before the AI dialog and
        // shares its z-index, so it would render *behind* it and look like F1
        // did nothing at all. ReviewerPrompt is excluded from this guard (see
        // BLOCKING_SURFACES_FOR_HELP below): it has no Escape handler and
        // unmounts outright once Help opens rather than stacking with it, so
        // neither risk above applies to it — and it is the one dialog whose
        // documented escape hatch *is* F1.
        if (document.querySelector(BLOCKING_SURFACES_FOR_HELP)) return
        useStore.getState().setHelpOpen(true)
        return
      }

      // Zoom: Ctrl/Cmd +/-/0 zooms the PDF; add Shift to scale the app font.
      // Detect the +/-/0 keys by character (which varies with Shift and layout,
      // e.g. '+' vs '=' vs '*', '-' vs '_') and by numpad code; detect reset by
      // the digit-0 code (Shift-independent, avoids the German Shift+0 → '=' clash).
      if (mod) {
        const reset = e.code === 'Digit0' || e.code === 'Numpad0'
        const inc =
          !reset && (e.key === '+' || e.key === '=' || e.key === '*' || e.code === 'NumpadAdd')
        const dec = !reset && (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract')
        if (inc || dec || reset) {
          e.preventDefault()
          const st = useStore.getState()
          if (e.shiftKey) {
            // App font size: Ctrl/Cmd+Shift +/-/0
            if (inc) st.increaseFont()
            else if (dec) st.decreaseFont()
            else st.resetFont()
          } else if (!editing) {
            // PDF zoom: Ctrl/Cmd +/-/0 (no PDF on screen while editing).
            if (inc) st.zoomInPdf()
            else if (dec) st.zoomOutPdf()
            else st.resetPdfZoom()
          }
          return
        }
      }

      // Paper navigation. Skip when typing in a field unless Alt is held.
      if (editing) return
      // ...and skip everything below while a modal is open. These bindings act
      // on the paper *behind* the dialog: pressing `3` while reading the Help
      // dialog's shortcut table excluded the hidden paper with the third reason
      // and auto-advanced the selection, with nothing visibly happening. Every
      // dialog in the app renders `.modal-overlay` (and a `role="dialog"`), so
      // one DOM check covers them all and cannot drift out of sync with a
      // hand-maintained list of open-flags. Scoped to the bare-key bindings
      // below (screening decisions and paper navigation), which are the ones
      // that fire from a single unmodified keystroke and act on hidden content;
      // the modifier combos above stay reachable on purpose.
      if (aModalIsOpen()) return
      const inField = isEditable(e.target)

      // Screening is hundreds of papers at seconds each, so the decision is a
      // keystroke. Bare letters only (a modifier means something else here)
      // and never while typing — the same rule `[`/`]` already follow below.
      // The store owns the auto-advance, so these and the panel's own buttons
      // cannot drift apart on it.
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
        // 1..9 pick the Nth configured exclusion reason and exclude in one
        // press — the exclusion and its reason are one decision, so they are
        // one keystroke and (via `setScreeningDecision`'s second argument)
        // one undo step.
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
      // PaperList's onListKeyDown already handles this exact combo when a
      // paper row has DOM focus, moving selection and focus together by one
      // row and calling preventDefault. Re-running nav() here double-advances
      // the selection while the focus ring lags a row behind, so defer to it
      // via e.defaultPrevented. Deliberate trade: this is the one case where
      // Alt+Arrow does not work "even while typing in a field" — ComboBox/
      // ModelPicker preventDefault on arrows while their input is focused.
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

  // Step through whatever the paper list is actually showing right now —
  // its rows carry `data-paper-id` in filtered/search order (see
  // `PaperList.tsx`) — rather than the project's raw paper order, so a
  // search filter and [ / ] / Alt+Arrow never disagree about "next". The
  // list's own local `query`/`mode` state isn't in the store, so the DOM is
  // the one place both agree on what's currently visible.
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
 * Is a modal dialog on screen? Every dialog in the app renders a
 * `.modal-overlay` wrapper (and marks itself `role="dialog"`), so this one
 * query covers all of them — including any added later — without a list of
 * per-dialog open-flags to keep in sync.
 */
/**
 * Is anything blocking-shaped on screen? Bare-key bindings act on the paper
 * *behind* it, invisibly, so they must not fire.
 *
 * This started as a `.modal-overlay` check on the claim that every dialog in
 * the app renders one. That was wrong twice over: `ErrorPanel` renders
 * `.error-overlay` (a full-viewport dimming backdrop — a failed save covers the
 * workspace, and `e` behind it silently excluded the hidden paper), and an open
 * `Dropdown` renders `.menu`, so typing the first letter of the project you are
 * hunting for in the Open menu excluded the current paper. Listing the surfaces
 * beats naming an invariant no one enforces.
 */
const BLOCKING_SURFACES = '.modal-overlay, .error-overlay, .menu'

// Same as BLOCKING_SURFACES, but F1's own branch uses this instead: it excludes
// ReviewerPrompt's overlay (opted out via its marker attribute) so F1 can
// still open Help while that prompt is up. Still blocks correctly if the
// prompt is ever stacked with ErrorPanel, ClosePrompt, or an open Dropdown —
// which a naive `!document.querySelector('.reviewer-prompt')` shortcut would
// not.
const BLOCKING_SURFACES_FOR_HELP =
  '.modal-overlay:not([data-yields-to-help]), .error-overlay, .menu'

function aModalIsOpen(): boolean {
  return document.querySelector(BLOCKING_SURFACES) !== null
}
