import { useStore } from '../state/store'
import { useEditorStore } from '../state/editorStore'
import { getPlatform } from '../platform'
import { Dropdown, type MenuItem } from './Dropdown'
import { SidebarToggle } from './SidebarToggle'

/** Top bar: Open / Save menus, appearance controls, help, and the dirty indicator. */
export function Toolbar() {
  const openProject = useStore((s) => s.openProject)
  const openRecent = useStore((s) => s.openRecent)
  const save = useStore((s) => s.save)
  const saveAs = useStore((s) => s.saveAs)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const runValidation = useStore((s) => s.runValidation)
  const requestCloseProject = useStore((s) => s.requestCloseProject)
  const editorOpen = useEditorStore((s) => s.open)
  const project = useStore((s) => s.project)
  const projectName = useStore((s) => s.projectName)
  const dirty = useStore((s) => s.dirty)
  const busy = useStore((s) => s.busy)
  const theme = useStore((s) => s.theme)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const increaseFont = useStore((s) => s.increaseFont)
  const decreaseFont = useStore((s) => s.decreaseFont)
  const resetFont = useStore((s) => s.resetFont)
  const recents = useStore((s) => s.recents)
  const forgetRecent = useStore((s) => s.forgetRecent)
  const projectTitle = useStore((s) => s.projectTitle)
  const saveHandle = useStore((s) => s.saveHandle)
  const setHelpOpen = useStore((s) => s.setHelpOpen)

  const modKey = getPlatform().kind === 'electron' && isMac() ? '⌘' : 'Ctrl'

  const openItems: MenuItem[] = [
    { type: 'item', label: 'Open file…', shortcut: `${modKey}+O`, onSelect: () => void openProject() },
    { type: 'separator' },
    { type: 'header', label: 'Recent projects' },
    ...(recents.length > 0
      ? recents.map<MenuItem>((r) => {
          const label = r.title || r.name
          const where = r.path ?? r.name
          // Only an explicit false disables it; undefined = not checked yet.
          const missing = r.available === false
          return {
            type: 'item',
            // The title when the project sets one, else the bare file name.
            label: missing ? `${label} (not found)` : label,
            // The path on hover is what tells two same-named projects apart.
            hint: missing ? `Not found — ${where}` : `${label}\n${where}`,
            disabled: missing,
            onSelect: () => void openRecent(r.id),
            onRemove: () => forgetRecent(r.id),
            removeTitle: 'Remove from recent projects',
          }
        })
      : [{ type: 'item', label: 'No recent files', disabled: true, onSelect: () => {} } as MenuItem]),
  ]

  const saveItems: MenuItem[] = [
    { type: 'item', label: 'Save', shortcut: `${modKey}+S`, disabled: !project, onSelect: () => void save() },
    {
      type: 'item',
      label: 'Save as…',
      shortcut: `${modKey}+Shift+S`,
      disabled: !project,
      onSelect: () => void saveAs(),
    },
  ]

  return (
    <header className="toolbar">
      {/* While the list is open its own header owns the toggle; once collapsed
          the button has to live out here, or there'd be no way to bring it back.
          The slot is always in the layout — hiding it rather than removing it
          keeps the title from shifting sideways as the sidebar is toggled. */}
      <span
        className={`toolbar-toggle-slot${sidebarCollapsed ? '' : ' is-hidden'}`}
        aria-hidden={!sidebarCollapsed}
      >
        <SidebarToggle />
      </span>

      <span className="app-title">SLR Helper</span>

      <div className="toolbar-actions">
        <Dropdown label="Open" title="Open a project" disabled={busy} items={openItems} />
        <Dropdown label="Save" title="Save the project" disabled={busy} items={saveItems} />
        <button
          type="button"
          title="Check every paper's annotations against the schema"
          onClick={runValidation}
          // Validation is about the annotations, so it means nothing while the
          // project editor is open.
          disabled={!project || busy || editorOpen}
        >
          Validate
        </button>
        <button
          type="button"
          title="Close this project and return to the start screen"
          onClick={requestCloseProject}
          disabled={!project || busy || editorOpen}
        >
          Close
        </button>
      </div>

      {/* The file name sits just left of the view controls; it carries the auto
          margin that pushes both to the right edge. */}
      <div className="toolbar-status">
        {project && (
          // The project's own title when it has one; the path on hover locates it.
          <span className="project-name" title={saveHandle?.path ?? projectName}>
            {projectTitle || projectName || 'untitled'}
            {dirty && <span className="dirty-dot" title="Unsaved changes">●</span>}
          </span>
        )}
      </div>

      <div className="toolbar-view">
        <div className="font-controls" role="group" aria-label="Font size">
          <button
            type="button"
            className="icon-btn"
            title={`Decrease app font size (${modKey}+Shift+-)`}
            onClick={decreaseFont}
          >
            A−
          </button>
          <button
            type="button"
            className="icon-btn"
            title={`Reset app font size (${modKey}+Shift+0)`}
            onClick={resetFont}
          >
            A
          </button>
          <button
            type="button"
            className="icon-btn"
            title={`Increase app font size (${modKey}+Shift++)`}
            onClick={increaseFont}
          >
            A+
          </button>
        </div>
        <button
          type="button"
          className="icon-btn"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle theme"
          onClick={toggleTheme}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Help (F1)"
          aria-label="Help"
          onClick={() => setHelpOpen(true)}
        >
          ?
        </button>
      </div>
    </header>
  )
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
}
