import { useEffect } from 'react'
import { useStore } from './state/store'
import { Toolbar } from './components/Toolbar'
import { PaperList } from './components/PaperList'
import { PdfViewer } from './components/PdfViewer'
import { AnnotationPanel } from './components/AnnotationPanel'
import { ErrorPanel } from './components/ErrorPanel'
import { HelpDialog } from './components/HelpDialog'
import { useKeybindings } from './hooks/useKeybindings'
import { useDirtyGuard } from './hooks/useDirtyGuard'

export function App() {
  useKeybindings()
  useDirtyGuard()

  const project = useStore((s) => s.project)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const openProject = useStore((s) => s.openProject)
  const loadFromUrl = useStore((s) => s.loadFromUrl)

  // Server deployment: ?project=<url> auto-loads a hosted project (+ its PDFs).
  useEffect(() => {
    const url = new URLSearchParams(window.location.search).get('project')
    if (url) void loadFromUrl(url)
  }, [loadFromUrl])

  return (
    <div className="app">
      <Toolbar />
      {project ? (
        <div className={sidebarCollapsed ? 'workspace sidebar-collapsed' : 'workspace'}>
          {!sidebarCollapsed && <PaperList />}
          <PdfViewer />
          <AnnotationPanel />
        </div>
      ) : (
        <div className="welcome">
          <div className="welcome-box">
            <h1>SLR Helper</h1>
            <p>Open a project JSON file to begin annotating.</p>
            <button type="button" className="primary" onClick={() => void openProject()}>
              Open project…
            </button>
          </div>
        </div>
      )}
      <ErrorPanel />
      <HelpDialog />
    </div>
  )
}
