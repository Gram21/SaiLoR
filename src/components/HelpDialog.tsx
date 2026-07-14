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
  [`${MOD} + / ${MOD} -`, 'Zoom the PDF in / out'],
  [`${MOD}+0`, 'Reset PDF zoom'],
  [`${MOD}+Shift + / -`, 'App font size larger / smaller'],
  [`${MOD}+Shift+0`, 'Reset app font size'],
  ['Alt+↓  /  ]', 'Next paper'],
  ['Alt+↑  /  [', 'Previous paper'],
  [`${MOD}+F`, 'Search within the PDF'],
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
              <strong>Don't have one yet?</strong> On the start screen use{' '}
              <em>New annotation JSON…</em> to define the annotation schema and attach the PDFs, or{' '}
              <em>Edit annotation JSON…</em> to change an existing one. In the editor,{' '}
              <em>Save JSON</em> just writes the file, while <em>Save JSON &amp; Begin Annotating</em>{' '}
              writes it and opens it for review. The shortcuts below for save and undo/redo work
              there too.
            </li>
            <li>
              <strong>Pick a paper</strong> from the left list (toggle the list with the ☰ button). A
              green dot marks papers that already have annotations.
            </li>
            <li>
              <strong>Read the PDF</strong> in the middle pane; its text is selectable. Use{' '}
              <strong>{MOD}+F</strong> to search within it. After following an internal link (e.g. a
              reference), the <em>↩ / ↪</em> buttons jump back to where you were and forward again.
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

          <h3>License</h3>
          <p>
            SLR Helper is free software, released under the{' '}
            <strong>GNU General Public License v3.0</strong> (GPL-3.0). You may use, study, share,
            and modify it under the terms of that license; it comes with no warranty. The full
            license text is in the <code>LICENSE</code> file distributed with the app, and online at{' '}
            <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noreferrer">
              gnu.org/licenses/gpl-3.0
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  )
}
