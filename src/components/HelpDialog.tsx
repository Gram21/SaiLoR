import { useEffect } from 'react'
import { useStore } from '../state/store'
import { getPlatform } from '../platform'

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const MOD = getPlatform().kind === 'electron' && isMac ? '⌘' : 'Ctrl'

const SHORTCUTS: Array<[string, string]> = [
  [`${MOD}+O`, 'Open a project file'],
  [`${MOD}+S`, 'Save'],
  [`${MOD}+Shift+S`, 'Save as…'],
  [`${MOD}+Z`, 'Undo annotation change'],
  [`${MOD}+Shift+Z`, 'Redo annotation change'],
  [`${MOD} +`, 'Increase app font size'],
  [`${MOD} -`, 'Decrease app font size'],
  [`${MOD}+0`, 'Reset app font size'],
  ['Alt+↓  /  ]', 'Next paper'],
  ['Alt+↑  /  [', 'Previous paper'],
  [`${MOD}+C / V / X / Z`, 'Copy / paste / cut / undo (native)'],
  ['F1', 'Open this help'],
]

/** Modal explaining the app basics and listing keyboard shortcuts. */
export function HelpDialog() {
  const open = useStore((s) => s.helpOpen)
  const setHelpOpen = useStore((s) => s.setHelpOpen)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHelpOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setHelpOpen])

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={() => setHelpOpen(false)}>
      <div className="modal help-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <strong>SLR Helper — Help</strong>
          <button type="button" className="icon-btn" onClick={() => setHelpOpen(false)} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          <h3>What this tool does</h3>
          <p>
            Open a project JSON file that contains an annotation schema and a list of papers, then
            read each paper's PDF and fill in the annotation fields on the right.
          </p>

          <h3>Basic workflow</h3>
          <ul>
            <li>
              <strong>Open</strong> a project via the <em>Open ▾</em> menu — pick a file or a recent
              project.
            </li>
            <li>
              <strong>Pick a paper</strong> from the left list (toggle the list with the ☰ button). A
              green dot marks papers that already have annotations.
            </li>
            <li>
              <strong>Read the PDF</strong> in the middle pane; its text is selectable.
            </li>
            <li>
              <strong>Annotate</strong> on the right. Repeatable entries show <em>+ Add</em> and a
              remove (<em>×</em>) control. Use the <em>⧉</em> button next to a field to insert the
              text currently selected in the PDF.
            </li>
            <li>
              <strong>Save</strong> via the <em>Save ▾</em> menu (or {MOD}+S). "Save as…" writes to a
              new file.
            </li>
          </ul>

          <h3>Appearance</h3>
          <p>
            Toggle light/dark with the ☾/☀ button and scale the app text with the <em>A− A A+</em>
            buttons. These affect the app only — the PDF paper stays white and normal-sized.
          </p>

          <h3>Keyboard shortcuts</h3>
          <table className="help-keys">
            <tbody>
              {SHORTCUTS.map(([keys, desc]) => (
                <tr key={keys}>
                  <td>
                    <kbd>{keys}</kbd>
                  </td>
                  <td>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
