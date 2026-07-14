import { useStore } from '../state/store'

/**
 * Show/hide the paper list. Rendered inside the list's own header while it is
 * open, and in the toolbar once it is collapsed — otherwise the button would
 * disappear along with the pane it reopens.
 */
export function SidebarToggle() {
  const collapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const project = useStore((s) => s.project)

  const label = collapsed ? 'Show paper list' : 'Hide paper list'

  return (
    <button
      type="button"
      className="icon-btn sidebar-toggle"
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      onClick={toggleSidebar}
      disabled={!project}
    >
      {/* The familiar "panel" glyph: a pane with its sidebar column marked off. */}
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="9" y1="3" x2="9" y2="21" />
      </svg>
    </button>
  )
}
