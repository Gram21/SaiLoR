import { useEffect, useRef, useState } from 'react'
import { useStore } from './state/store'
import { Toolbar } from './components/Toolbar'
import { PaperList } from './components/PaperList'
import { PdfViewer } from './components/PdfViewer'
import { AnnotationPanel } from './components/AnnotationPanel'
import { ErrorPanel } from './components/ErrorPanel'
import { HelpDialog } from './components/HelpDialog'
import { Splitter } from './components/Splitter'
import { useKeybindings } from './hooks/useKeybindings'
import { useDirtyGuard } from './hooks/useDirtyGuard'
import { useElectronCloseGuard } from './hooks/useElectronCloseGuard'
import {
  loadPaneWidths,
  savePaneWidths,
  PANE_LEFT_MIN,
  PANE_LEFT_MAX,
  PANE_RIGHT_MIN,
  PANE_RIGHT_MAX,
} from './state/settings'

export function App() {
  useKeybindings()
  useDirtyGuard()
  useElectronCloseGuard()

  const project = useStore((s) => s.project)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const openProject = useStore((s) => s.openProject)
  const loadFromUrl = useStore((s) => s.loadFromUrl)

  const workspaceRef = useRef<HTMLDivElement>(null)
  const [panes, setPanes] = useState(loadPaneWidths)

  // Server deployment: ?project=<url> auto-loads a hosted project (+ its PDFs).
  useEffect(() => {
    const url = new URLSearchParams(window.location.search).get('project')
    if (url) void loadFromUrl(url)
  }, [loadFromUrl])

  // Persist pane widths whenever they change (avoids stale-closure saves).
  useEffect(() => {
    savePaneWidths(panes)
  }, [panes])

  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

  const resizeLeft = (clientX: number) => {
    const rect = workspaceRef.current?.getBoundingClientRect()
    if (!rect) return
    setPanes((p) => ({ ...p, left: clamp(clientX - rect.left, PANE_LEFT_MIN, PANE_LEFT_MAX) }))
  }
  const resizeRight = (clientX: number) => {
    const rect = workspaceRef.current?.getBoundingClientRect()
    if (!rect) return
    setPanes((p) => ({ ...p, right: clamp(rect.right - clientX, PANE_RIGHT_MIN, PANE_RIGHT_MAX) }))
  }

  // Build the grid template from the current pane widths.
  const gridTemplateColumns = sidebarCollapsed
    ? `minmax(0, 1fr) 6px ${panes.right}px`
    : `${panes.left}px 6px minmax(0, 1fr) 6px ${panes.right}px`

  return (
    <div className="app">
      <Toolbar />
      {project ? (
        <div className="workspace" ref={workspaceRef} style={{ gridTemplateColumns }}>
          {!sidebarCollapsed && (
            <>
              <PaperList />
              <Splitter onResize={resizeLeft} />
            </>
          )}
          <PdfViewer />
          <Splitter onResize={resizeRight} />
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
