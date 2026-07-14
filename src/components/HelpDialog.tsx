import { useEffect } from 'react'
import { useStore } from '../state/store'
import { useEditorStore } from '../state/editorStore'
import { getPlatform } from '../platform'

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const MOD = getPlatform().kind === 'electron' && isMac ? '⌘' : 'Ctrl'

/** Shortcuts while annotating a project. */
const ANNOTATE_KEYS: Array<[string, string]> = [
  [`${MOD}+O`, 'Open a project file'],
  [`${MOD}+S`, 'Save'],
  [`${MOD}+Shift+S`, 'Save as…'],
  [`${MOD}+Z`, 'Undo annotation change'],
  [`${MOD}+Shift+Z`, 'Redo annotation change'],
  [`${MOD}+F`, 'Search within the PDF'],
  [`${MOD} + / ${MOD} -`, 'Zoom the PDF in / out'],
  [`${MOD}+0`, 'Reset PDF zoom'],
  ['Alt+↓  /  ]', 'Next paper'],
  ['Alt+↑  /  [', 'Previous paper'],
  [`${MOD}+Shift + / -`, 'App font size larger / smaller'],
  [`${MOD}+Shift+0`, 'Reset app font size'],
  [`${MOD}+C / V / X`, 'Copy / paste / cut (native)'],
  ['F1', 'Open this help'],
]

/** Shortcuts on the start screen, before anything is open. */
const START_KEYS: Array<[string, string]> = [
  [`${MOD}+O`, 'Open a project file'],
  [`${MOD}+Shift + / -`, 'App font size larger / smaller'],
  [`${MOD}+Shift+0`, 'Reset app font size'],
  ['F1', 'Open this help'],
]

/** Shortcuts while building or editing the annotation JSON. */
const EDITOR_KEYS: Array<[string, string]> = [
  [`${MOD}+S`, 'Save the JSON (stay in the editor)'],
  [`${MOD}+Shift+S`, 'Save to a new location'],
  [`${MOD}+Z`, 'Undo a schema or paper change'],
  [`${MOD}+Shift+Z`, 'Redo'],
  [`${MOD}+Shift + / -`, 'App font size larger / smaller'],
  [`${MOD}+Shift+0`, 'Reset app font size'],
  [`${MOD}+C / V / X`, 'Copy / paste / cut (native)'],
  ['F1', 'Open this help'],
]

function ShortcutTable({ keys }: { keys: Array<[string, string]> }) {
  return (
    <table className="help-keys">
      <tbody>
        {keys.map(([combo, desc]) => (
          <tr key={combo}>
            <td>
              <kbd>{combo}</kbd>
            </td>
            <td>{desc}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Help for the start screen — nothing is open yet, so describe the tool itself. */
function StartHelp() {
  return (
    <>
      <h3>What this tool does</h3>
      <p>
        SLR Helper supports <strong>Systematic Literature Reviews</strong>. Everything for a review
        lives in a single <strong>project JSON file</strong>, which holds two things: an{' '}
        <strong>annotation schema</strong> — the fields you want to extract from every paper — and
        the <strong>list of papers</strong>, each pointing at its PDF.
      </p>
      <p>
        While reviewing, the app shows the paper's PDF next to a form built from your schema. You
        fill the fields in (grabbing text straight from the PDF if you like), and the answers are
        saved back into the same JSON file — ready to hand to a co-reviewer or analyse later.
      </p>

      <h3>Your options from here</h3>
      <ul>
        <li>
          <strong>Open project…</strong> — open an existing project JSON and start annotating. If
          you've opened projects before, they're listed underneath for one click.
        </li>
        <li>
          <strong>New annotation JSON…</strong> — start a review from scratch. You choose where the
          JSON should live, define the annotation schema (the fields, their types, whether they
          repeat or nest), and attach the PDFs to review.
        </li>
        <li>
          <strong>Edit annotation JSON…</strong> — open an existing project and change its schema or
          its list of papers. Annotations already filled in are preserved.
        </li>
      </ul>

      <h3>Which one do I want?</h3>
      <p>
        If somebody handed you a project file, use <em>Open project…</em>. If you're setting up a new
        review, use <em>New annotation JSON…</em> — you can always come back and adjust the schema
        later with <em>Edit annotation JSON…</em>.
      </p>

      <h3>Keyboard shortcuts</h3>
      <ShortcutTable keys={START_KEYS} />
    </>
  )
}

/** Help for the annotation view. */
function AnnotateHelp() {
  return (
    <>
      <h3>What this tool does</h3>
      <p>
        Open a project JSON file that contains an annotation schema and a list of papers, then read
        each paper's PDF and fill in the annotation fields on the right.
      </p>

      <h3>Basic workflow</h3>
      <ul>
        <li>
          <strong>Open</strong> a project via the <em>Open ▾</em> menu — pick a file or a recent
          project. To create or change a project's schema, use <em>New annotation JSON…</em> /{' '}
          <em>Edit annotation JSON…</em> on the start screen.
        </li>
        <li>
          <strong>Pick a paper</strong> from the left list. A green dot marks papers that already
          have annotations. The button in the list's header hides it to make room for the paper;
          once hidden, the same button in the top bar brings it back.
        </li>
        <li>
          <strong>Read the PDF</strong> in the middle pane; its text is selectable. Use{' '}
          <strong>{MOD}+F</strong> to search within it. After following an internal link (e.g. a
          reference), the <em>↩ / ↪</em> buttons jump back to where you were and forward again.
        </li>
        <li>
          <strong>Annotate</strong> on the right. Repeatable entries show <em>+ Add</em> and a
          remove (<em>×</em>) control. Use the <em>⧉</em> button next to a field to insert the text
          currently selected in the PDF.
        </li>
        <li>
          <strong>Validate</strong> checks every paper against the schema: required fields that are
          still empty, values of the wrong type, and values outside a dropdown's choices. Required
          fields are marked with a red <em>*</em>. A <em>Yes/no</em> field always counts as
          answered — an unticked box means <em>no</em>.
        </li>
        <li>
          <strong>Save</strong> via the <em>Save ▾</em> menu (or {MOD}+S). "Save as…" writes to a new
          file, and the PDF references are re-derived so they still resolve from there.
        </li>
      </ul>

      <h3>Keyboard shortcuts</h3>
      <ShortcutTable keys={ANNOTATE_KEYS} />
    </>
  )
}

/** Help for the project editor (schema + papers). */
function EditorHelp() {
  return (
    <>
      <h3>What this screen does</h3>
      <p>
        This is where you define a project: the <strong>annotation schema</strong> (the fields
        reviewers fill in for every paper) and the <strong>PDFs</strong> to annotate. It writes the
        project JSON that the annotation view then opens.
      </p>

      <h3>Where the JSON lives</h3>
      <p>
        The location is chosen up front and shown at the top — use <em>Change…</em> to move it.
        PDFs are referenced <strong>relative to the JSON file</strong>, so if you move the JSON the
        references are re-derived for you.
      </p>

      <h3>Building the schema</h3>
      <ul>
        <li>
          <strong>Add a field</strong> with <em>+ Add field</em>, or nest one under another with{' '}
          <em>+ Child</em>. Each field has a name, a type, and an optional description shown on
          hover while annotating.
        </li>
        <li>
          <strong>Type:</strong> <em>Text</em>, <em>Number</em>, <em>Yes/no</em>, or{' '}
          <em>Group</em> — a group holds no value of its own and just contains nested fields.
        </li>
        <li>
          <strong>Repeats:</strong> <em>min</em> and <em>max</em> control how many times a field can
          occur. Tick <em>∞</em> for an unbounded number — the annotator then gets <em>+ Add</em> to
          create as many entries as needed.
        </li>
        <li>
          <strong>Fixed choices:</strong> on a <em>Text</em> field, add options to turn it into a
          dropdown. With no options it stays free text.
        </li>
        <li>
          <strong>Reorder and nest by dragging</strong> a row's <em>⠿</em> handle: drop near a row's
          top or bottom edge to place it before or after, or drop in the middle of a row to nest it
          inside that row.
        </li>
      </ul>

      <h3>Adding papers</h3>
      <p>
        <em>+ Add PDFs…</em> attaches PDFs. A PDF already in the project is not added twice, and the
        title and authors are read from the PDF where possible — check them, since they are a
        best-effort guess. Every field stays editable, and rows can be dragged to reorder.
      </p>

      <h3>Saving</h3>
      <p>
        <strong>Save JSON</strong> writes the file and leaves you here to keep working.{' '}
        <strong>Save JSON &amp; Begin Annotating</strong> writes it and opens it for review. Both
        check the project first and tell you what to fix if something is off.
      </p>

      <h3>Keyboard shortcuts</h3>
      <ShortcutTable keys={EDITOR_KEYS} />
    </>
  )
}

/** Modal explaining the current mode and listing its keyboard shortcuts. */
export function HelpDialog() {
  const open = useStore((s) => s.helpOpen)
  const setHelpOpen = useStore((s) => s.setHelpOpen)
  // The help must describe the screen the user is actually looking at: the
  // editor, an open project, or the start screen with neither.
  const editing = useEditorStore((s) => s.open)
  const hasProject = useStore((s) => s.project !== null)
  const mode = editing ? 'editor' : hasProject ? 'annotate' : 'start'

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
      <div
        className="modal help-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <strong>
            SLR Helper — Help{' '}
            <span className="help-mode">
              {mode === 'editor'
                ? 'Editing the annotation JSON'
                : mode === 'annotate'
                  ? 'Annotating'
                  : 'Getting started'}
            </span>
          </strong>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setHelpOpen(false)}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="modal-body">
          {mode === 'editor' ? <EditorHelp /> : mode === 'annotate' ? <AnnotateHelp /> : <StartHelp />}

          <h3>Appearance</h3>
          <p>
            Toggle light/dark with the ☾/☀ button and scale the app text with the <em>A− A A+</em>
            buttons. These affect the app only — the PDF paper stays white and normal-sized.
          </p>

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
