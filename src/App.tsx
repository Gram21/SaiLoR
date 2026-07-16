import { useEffect, useRef, useState } from 'react'
import { useStore } from './state/store'
import { useEditorStore } from './state/editorStore'
import { useGitStore } from './state/gitStore'
import { getPlatform } from './platform'
import { ProjectEditor } from './components/ProjectEditor'
import { Toolbar } from './components/Toolbar'
import { PaperList } from './components/PaperList'
import { PdfViewer } from './components/PdfViewer'
import { AnnotationPanel } from './components/AnnotationPanel'
import { ScreeningPanel } from './components/ScreeningPanel'
import { ScreeningRecord } from './components/ScreeningRecord'
import { ScreeningSummary } from './components/ScreeningSummary'
import { ScreeningImportDialog } from './components/ScreeningImportDialog'
import { ErrorPanel } from './components/ErrorPanel'
import { HelpDialog } from './components/HelpDialog'
import { ValidationDialog } from './components/ValidationDialog'
import { ConsolidationDialog } from './components/ConsolidationDialog'
import { ReviewerPrompt } from './components/ReviewerPrompt'
import { AgreementDialog } from './components/AgreementDialog'
import { DisagreementOverview } from './components/DisagreementOverview'
import { ClosePrompt } from './components/ClosePrompt'
import { AiDialog } from './components/AiDialog'
import { LlmSettingsDialog } from './components/LlmSettingsDialog'
import { GitCloneDialog } from './components/GitCloneDialog'
import { GitDialog } from './components/GitDialog'
import { GitMergeDialog } from './components/GitMergeDialog'
import { shortenPath } from './platform/recents'
import { Splitter } from './components/Splitter'
import { useKeybindings } from './hooks/useKeybindings'
import { useDirtyGuard } from './hooks/useDirtyGuard'
import { useElectronCloseGuard } from './hooks/useElectronCloseGuard'
import { useConsolidationAlignment } from './hooks/useConsolidationAlignment'
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
  useConsolidationAlignment()

  const project = useStore((s) => s.project)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const openProject = useStore((s) => s.openProject)
  const loadFromUrl = useStore((s) => s.loadFromUrl)
  const recents = useStore((s) => s.recents)
  const openRecent = useStore((s) => s.openRecent)
  const forgetRecent = useStore((s) => s.forgetRecent)
  const refreshRecents = useStore((s) => s.refreshRecents)
  const screening = useStore((s) => s.project?.screening != null)
  const screeningShowPdf = useStore((s) => s.screeningShowPdf)
  const editorOpen = useEditorStore((s) => s.open)
  const startNew = useEditorStore((s) => s.startNew)
  const startEdit = useEditorStore((s) => s.startEdit)
  const startEditRecent = useEditorStore((s) => s.startEditRecent)
  const startFromScreening = useEditorStore((s) => s.startFromScreening)
  const appVersion = useStore((s) => s.appVersion)
  const update = useStore((s) => s.update)
  const checkForUpdate = useStore((s) => s.checkForUpdate)

  const saveHandle = useStore((s) => s.saveHandle)
  const gitProbe = useGitStore((s) => s.probe)
  const probeGit = useGitStore((s) => s.probeGit)
  const refreshRepo = useGitStore((s) => s.refreshRepo)
  const openClone = useGitStore((s) => s.openClone)

  const workspaceRef = useRef<HTMLDivElement>(null)
  const [panes, setPanes] = useState(loadPaneWidths)

  // Server deployment: ?project=<url> auto-loads a hosted project (+ its PDFs).
  useEffect(() => {
    const url = new URLSearchParams(window.location.search).get('project')
    if (url) void loadFromUrl(url)
  }, [loadFromUrl])

  // Look for a newer release once per launch (the result is cached for a day).
  useEffect(() => {
    void checkForUpdate()
  }, [checkForUpdate])

  // Find out which recent projects still exist, so the gone ones grey out.
  useEffect(() => {
    void refreshRecents()
  }, [refreshRecents])

  // Whether this machine has git at all — asked once per launch, distinct
  // from whether the *runtime* can reach one (`getPlatform().getGit()`).
  useEffect(() => {
    void probeGit()
  }, [probeGit])

  // The open project's JSON may or may not sit in a repository, and "save as"
  // can move it into or out of one — an effect, not a call from store.ts,
  // because gitStore reads the main store and the main store must not read
  // back (see gitStore.ts's own doc comment).
  useEffect(() => {
    void refreshRepo(saveHandle)
  }, [saveHandle, refreshRepo])

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
      {editorOpen ? (
        <ProjectEditor />
      ) : project ? (
        <div className="workspace" ref={workspaceRef} style={{ gridTemplateColumns }}>
          {!sidebarCollapsed && (
            <>
              <PaperList />
              <Splitter onResize={resizeLeft} />
            </>
          )}
          {screening && !screeningShowPdf ? <ScreeningRecord /> : <PdfViewer />}
          <Splitter onResize={resizeRight} />
          {screening ? <ScreeningPanel /> : <AnnotationPanel />}
        </div>
      ) : (
        <div className="welcome">
          <div className="welcome-box">
            <h1>SaiLoR</h1>
            <p>Open a project JSON file to begin annotating, or set one up.</p>
            <button type="button" className="primary" onClick={() => void openProject()}>
              Open project…
            </button>
            <div className="welcome-create">
              <button type="button" onClick={() => void startNew()}>
                New annotation JSON…
              </button>
              <button type="button" onClick={() => void startEdit()}>
                Edit annotation JSON…
              </button>
              <button type="button" onClick={() => void startFromScreening()}>
                New from screening…
              </button>
              {/* Absent in the browser build entirely — see GitCloneDialog's
                  doc comment and PlatformAdapter.getGit() for why there is no
                  "local git" for a browser page to fall back to. */}
              {getPlatform().getGit() && (
                <button
                  type="button"
                  onClick={() => openClone()}
                  disabled={gitProbe !== null && !gitProbe.available}
                  title={gitProbe && !gitProbe.available ? gitProbe.error : undefined}
                >
                  Import from git…
                </button>
              )}
            </div>
            {recents.length > 0 && (
              <div className="welcome-recents">
                <div className="welcome-recents-label">Recent projects</div>
                {recents.map((item) => {
                  const label = item.title || item.name
                  const where = item.path ?? item.name
                  // Keep the tail: the folder + file name are what tell two
                  // same-named projects apart. Full path is on hover.
                  const shortWhere = shortenPath(where)
                  // `undefined` means "not checked yet" — only an explicit false
                  // greys the entry out, so nothing flickers on first paint.
                  const missing = item.available === false
                  return (
                    <div key={item.id} className="welcome-recent-row">
                      <button
                        type="button"
                        className={`welcome-recent${missing ? ' unavailable' : ''}`}
                        // The full text on hover, since both lines truncate.
                        title={missing ? `Not found — ${where}` : `${label}\n${where}`}
                        disabled={missing}
                        onClick={() => void openRecent(item.id)}
                      >
                        {/* The project's own title, falling back to the file name. */}
                        <span className="recent-title">
                          {label}
                          {missing && <span className="recent-missing">not found</span>}
                        </span>
                        {/* The path distinguishes two projects sharing a name. */}
                        <span className="recent-path">{shortWhere}</span>
                      </button>
                      <button
                        type="button"
                        className="icon-btn recent-edit"
                        title="Edit this project's annotation schema"
                        aria-label={`Edit the annotation schema of ${label}`}
                        disabled={missing}
                        onClick={() => void startEditRecent(item.id)}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="icon-btn recent-remove"
                        title="Remove from recent projects"
                        aria-label={`Remove ${label} from recent projects`}
                        onClick={() => forgetRecent(item.id)}
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="welcome-version">
              {update && (
                <div className="update-notice">
                  <span>
                    <strong>Version {update.latest} is available</strong> — you have {appVersion}.
                  </span>
                  <span className="update-links">
                    {/* When we know the machine, link straight at its installer;
                        otherwise the release page is the best we can offer. */}
                    {update.download && (
                      <a
                        className="update-download"
                        href={update.download.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={update.download.name}
                      >
                        Download for {update.download.label}
                      </a>
                    )}
                    <a href={update.url} target="_blank" rel="noopener noreferrer">
                      Release notes
                    </a>
                  </span>
                </div>
              )}
              <span className="version-label">SaiLoR v{appVersion}</span>
            </div>
          </div>
        </div>
      )}
      <ErrorPanel />
      <HelpDialog />
      <ValidationDialog />
      <ConsolidationDialog />
      <ReviewerPrompt />
      <AgreementDialog />
      <DisagreementOverview />
      <ClosePrompt />
      <AiDialog />
      <LlmSettingsDialog />
      <ScreeningSummary />
      <ScreeningImportDialog />
      <GitCloneDialog />
      <GitDialog />
      <GitMergeDialog />
    </div>
  )
}
