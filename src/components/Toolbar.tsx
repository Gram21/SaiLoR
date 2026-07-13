import { useStore } from '../state/store'
import { getPlatform } from '../platform'

/** Top bar: open / save / save-as, sidebar toggle, and the dirty indicator. */
export function Toolbar() {
  const openProject = useStore((s) => s.openProject)
  const save = useStore((s) => s.save)
  const saveAs = useStore((s) => s.saveAs)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const project = useStore((s) => s.project)
  const projectName = useStore((s) => s.projectName)
  const dirty = useStore((s) => s.dirty)
  const busy = useStore((s) => s.busy)

  const modKey = getPlatform().kind === 'electron' && isMac() ? '⌘' : 'Ctrl'

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
        <button type="button" onClick={() => void openProject()} disabled={busy}>
          Open…
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!project || busy}
          title={`Save (${modKey}+S)`}
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => void saveAs()}
          disabled={!project || busy}
          title={`Save as (${modKey}+Shift+S)`}
        >
          Save as…
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
