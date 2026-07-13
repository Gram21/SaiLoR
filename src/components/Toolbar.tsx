import { useStore } from '../state/store'
import { getPlatform } from '../platform'
import { Dropdown, type MenuItem } from './Dropdown'

/** Top bar: Open / Save menus, appearance controls, help, and the dirty indicator. */
export function Toolbar() {
  const openProject = useStore((s) => s.openProject)
  const openRecent = useStore((s) => s.openRecent)
  const save = useStore((s) => s.save)
  const saveAs = useStore((s) => s.saveAs)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
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
  const setHelpOpen = useStore((s) => s.setHelpOpen)

  const modKey = getPlatform().kind === 'electron' && isMac() ? '⌘' : 'Ctrl'

  const openItems: MenuItem[] = [
    { type: 'item', label: 'Open file…', shortcut: `${modKey}+O`, onSelect: () => void openProject() },
    { type: 'separator' },
    { type: 'header', label: 'Recent projects' },
    ...(recents.length > 0
      ? recents.map<MenuItem>((r) => ({
          type: 'item',
          label: r.name,
          onSelect: () => void openRecent(r.id),
        }))
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
      <button
        type="button"
        className="icon-btn"
        title={sidebarCollapsed ? 'Show paper list' : 'Hide paper list'}
        onClick={toggleSidebar}
        disabled={!project}
      >
        ☰
      </button>

      <span className="app-title">SLR Helper</span>

      <div className="toolbar-actions">
        <Dropdown label="Open" title="Open a project" disabled={busy} items={openItems} />
        <Dropdown label="Save" title="Save the project" disabled={busy} items={saveItems} />
      </div>

      <div className="toolbar-view">
        <div className="font-controls" role="group" aria-label="Font size">
          <button
            type="button"
            className="icon-btn"
            title={`Decrease font size (${modKey}+-)`}
            onClick={decreaseFont}
          >
            A−
          </button>
          <button
            type="button"
            className="icon-btn"
            title={`Reset font size (${modKey}+0)`}
            onClick={resetFont}
          >
            A
          </button>
          <button
            type="button"
            className="icon-btn"
            title={`Increase font size (${modKey}++)`}
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

      <div className="toolbar-status">
        {project && (
          <span className="project-name">
            {projectName || 'untitled'}
            {dirty && <span className="dirty-dot" title="Unsaved changes">●</span>}
          </span>
        )}
      </div>
    </header>
  )
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
}
