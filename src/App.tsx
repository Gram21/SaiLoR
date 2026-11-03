// [impl->req~ui-70~1]
import { useEffect, useRef, useState } from 'react'
import { useStore } from './state/store'
import { useEditorStore } from './state/editorStore'
import { useGitStore } from './state/gitStore'
import { getPlatform } from './platform'
import { isTauri } from './platform/adapter'
import { NEW_ISSUE_URL } from './model/version'
import { ProjectEditor } from './components/ProjectEditor'
import { Toolbar } from './components/Toolbar'
import { PaperList } from './components/PaperList'
import { PdfViewer } from './components/PdfViewer'
import { AnnotationPanel } from './components/AnnotationPanel'
import { ScreeningPanel } from './components/ScreeningPanel'
import { ScreeningRecord } from './components/ScreeningRecord'
import { ScreeningSummary } from './components/ScreeningSummary'
import { ScreeningImportDialog } from './components/ScreeningImportDialog'
import { DuplicateReviewDialog } from './components/DuplicateReviewDialog'
import { ErrorPanel } from './components/ErrorPanel'
import { HelpDialog } from './components/HelpDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { SchemaInfoDialog } from './components/SchemaInfoDialog'
import { ValidationDialog } from './components/ValidationDialog'
import { ExportPdfDialog } from './components/ExportPdfDialog'
import { ConsolidationDialog } from './components/ConsolidationDialog'
import { ReviewerPrompt } from './components/ReviewerPrompt'
import { PersonPicker } from './components/PersonPicker'
import { RepoSetupPrompt } from './components/RepoSetupPrompt'
import { RepoSetupToast } from './components/RepoSetupToast'
import { AgreementDialog } from './components/AgreementDialog'
import { DisagreementOverview } from './components/DisagreementOverview'
import { ConsolidationOverview } from './components/ConsolidationOverview'
import { ClosePrompt } from './components/ClosePrompt'
import { ConsolidationUpdatePrompt } from './components/ConsolidationUpdatePrompt'
import { AiDialog } from './components/AiDialog'
import { AiScreeningDialog } from './components/AiScreeningDialog'
import { LlmSettingsDialog } from './components/LlmSettingsDialog'
import { GitCloneDialog } from './components/GitCloneDialog'
import { GitDialog } from './components/GitDialog'
import { GitMergeDialog } from './components/GitMergeDialog'
import { StaleSaveDialog } from './components/StaleSaveDialog'
import { SplitAnnotationsDialog } from './components/SplitAnnotationsDialog'
import { BranchSwitchPrompt } from './components/BranchSwitchPrompt'
import { NewBranchPrompt } from './components/NewBranchPrompt'
import { MergeBranchPrompt } from './components/MergeBranchPrompt'
import { DeleteBranchPrompt } from './components/DeleteBranchPrompt'
import { GitHistoryDialog } from './components/GitHistoryDialog'
import { shortenPath } from './platform/recents'
import { Splitter } from './components/Splitter'
import { useKeybindings } from './hooks/useKeybindings'
import { useDirtyGuard } from './hooks/useDirtyGuard'
import { useCloseGuard } from './hooks/useCloseGuard'
import { useWindowTitle } from './hooks/useWindowTitle'
import { useConsolidationAlignment } from './hooks/useConsolidationAlignment'
import { useAutosave } from './hooks/useAutosave'
import { useUpstreamPolling } from './hooks/useUpstreamPolling'
import {
  loadPaneWidths,
  savePaneWidths,
  PANE_LEFT_MIN,
  PANE_LEFT_MAX,
  PANE_RIGHT_MIN,
  PANE_RIGHT_MAX,
} from './state/settings'
import { rich, useT } from './i18n'

export function App() {
  const t = useT()
  useKeybindings()
  useDirtyGuard()
  useCloseGuard()
  useWindowTitle()
  useConsolidationAlignment()
  useAutosave()
  useUpstreamPolling()

  const project = useStore((s) => s.project)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const openProject = useStore((s) => s.openProject)
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
  const nativeUpdate = useStore((s) => s.nativeUpdate)
  const updateProgress = useStore((s) => s.updateProgress)
  const updateReady = useStore((s) => s.updateReady)
  const updateError = useStore((s) => s.updateError)
  const downloadUpdate = useStore((s) => s.downloadUpdate)
  const installUpdate = useStore((s) => s.installUpdate)

  const saveHandle = useStore((s) => s.saveHandle)
  const gitProbe = useGitStore((s) => s.probe)
  const probeGit = useGitStore((s) => s.probeGit)
  const refreshRepo = useGitStore((s) => s.refreshRepo)
  const openClone = useGitStore((s) => s.openClone)

  const workspaceRef = useRef<HTMLDivElement>(null)
  const [panes, setPanes] = useState(loadPaneWidths)

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
  //
  // Keyed on the handle's *path*, not its object identity: `gitStore`'s own
  // `reloadOpenProject` (after a field-level commit/discard, a pull, or a
  // branch switch) re-opens the *same* file and hands back a fresh handle
  // object every time, purely as a side effect of going through the ordinary
  // open path. Keying on identity re-ran `refreshRepo` on every one of those
  // reloads too — which starts by nulling `gitStore`'s `repo` — racing the
  // very `refreshStatus()` call those same flows make right afterward. When
  // `refreshRepo`'s null won that race, `refreshStatus` saw `repo` as null
  // and silently skipped refreshing `panel.status`, leaving the Git dialog's
  // changes list stuck showing the just-committed change until the reviewer
  // clicked the manual ↻ refresh. The repo itself cannot change from a
  // same-path reload, so there is nothing to re-probe.
  useEffect(() => {
    void refreshRepo(saveHandle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveHandle?.path, refreshRepo])

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

  // SaiLoR for the web is discontinued as of the split-annotation-file storage
  // change: too much of the app (multi-file save/load, git) depends on real
  // filesystem access the File System Access API never gave us reliably
  // enough across browsers. Gate before any project-opening UI ever renders —
  // no file picker, no drag-and-drop, nothing that could start a session this
  // build can't finish.
  if (!isTauri()) {
    return (
      <div className="app">
        <div className="welcome">
          <div className="welcome-box">
            <img
              className="welcome-logo"
              src={`${import.meta.env.BASE_URL}logo.svg`}
              alt=""
              width={80}
              height={80}
            />
            <h1>SaiLoR</h1>
            <p>{t('app.web.discontinued')}</p>
            <p>{t('app.web.useDesktop')}</p>
            <a
              className="primary"
              href="https://github.com/Gram21/SaiLoR/releases"
              target="_blank"
              rel="noreferrer"
            >
              {t('app.web.download')}
            </a>
          </div>
        </div>
      </div>
    )
  }

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
            {/* `BASE_URL`, not a root-absolute path: `base: './'` (vite.config.ts)
                is what lets the same build run from a server subpath and from
                the packaged app's asset URL, and a hard-coded "/logo.svg" would 404 under
                the latter. */}
            <img
              className="welcome-logo"
              src={`${import.meta.env.BASE_URL}logo.svg`}
              alt=""
              width={80}
              height={80}
            />
            <h1>SaiLoR</h1>
            <p>{t('app.welcome.intro')}</p>
            <button
              type="button"
              className="primary"
              onClick={() => void openProject()}
              title={t('app.welcome.openTitle')}
            >
              {t('app.welcome.open')}
            </button>
            <div className="welcome-create">
              <button type="button" onClick={() => void startNew()} title={t('app.welcome.newTitle')}>
                {t('app.welcome.new')}
              </button>
              <button
                type="button"
                onClick={() => void startEdit()}
                title={t('app.welcome.editTitle')}
              >
                {t('app.welcome.edit')}
              </button>
              <button
                type="button"
                onClick={() => void startFromScreening()}
                title={t('app.welcome.fromScreeningTitle')}
              >
                {t('app.welcome.fromScreening')}
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
                  {t('toolbar.git.importRemote')}
                </button>
              )}
            </div>
            {recents.length > 0 && (
              <div className="welcome-recents">
                <div className="welcome-recents-label">{t('toolbar.recent.header')}</div>
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
                        title={missing ? t('toolbar.recent.missingHint', { where }) : `${label}\n${where}`}
                        disabled={missing}
                        onClick={() => void openRecent(item.id)}
                      >
                        {/* The project's own title, falling back to the file name. */}
                        <span className="recent-title">
                          {label}
                          {missing && <span className="recent-missing">{t('app.welcome.notFound')}</span>}
                        </span>
                        {/* The path distinguishes two projects sharing a name. */}
                        <span className="recent-path">{shortWhere}</span>
                      </button>
                      <button
                        type="button"
                        className="icon-btn recent-edit"
                        title={t('app.welcome.editRecent')}
                        aria-label={t('app.welcome.editRecentAria', { name: label })}
                        disabled={missing}
                        onClick={() => void startEditRecent(item.id)}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="icon-btn recent-remove"
                        title={t('toolbar.recent.remove')}
                        aria-label={t('app.welcome.removeRecentAria', { name: label })}
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
                    {rich('app.update.available', { version: update.latest, current: appVersion })}
                  </span>
                  <span className="update-links">
                    {nativeUpdate ? (
                      // A real, explicitly user-triggered download + install, never
                      // automatic. Only where the shell reported it can self-update
                      // (`checkForNativeUpdate`); elsewhere (e.g. a .deb/.rpm install,
                      // a Tauri .deb) the plain download link below stays.
                      updateReady ? (
                        <button
                          type="button"
                          className="update-download"
                          onClick={() => void installUpdate()}
                          title={t('app.update.restartTitle')}
                        >
                          {t('app.update.restart')}
                        </button>
                      ) : updateProgress != null ? (
                        <span>{t('app.update.progress', { percent: Math.round(updateProgress) })}</span>
                      ) : (
                        <button
                          type="button"
                          className="update-download"
                          onClick={() => void downloadUpdate()}
                          title={t('app.update.downloadTitle')}
                        >
                          {t('app.update.download')}
                        </button>
                      )
                    ) : (
                      // When we know the machine, link straight at its installer;
                      // otherwise the release page is the best we can offer.
                      update.download && (
                        <a
                          className="update-download"
                          href={update.download.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={update.download.name}
                        >
                          {t('app.update.downloadFor', { label: update.download.label })}
                        </a>
                      )
                    )}
                    <a href={update.url} target="_blank" rel="noopener noreferrer">
                      {t('app.update.notes')}
                    </a>
                  </span>
                  {updateError && (
                    <span className="update-error">
                      {t('app.update.failed')}
                    </span>
                  )}
                </div>
              )}
              <span className="version-label">SaiLoR v{appVersion}</span>
              <a
                className="welcome-report-bug"
                href={NEW_ISSUE_URL}
                target="_blank"
                rel="noreferrer"
                title={t('app.report.title')}
              >
                {t('app.report.label')}
              </a>
            </div>
          </div>
        </div>
      )}
      <ErrorPanel />
      <HelpDialog />
      <SettingsDialog />
      <SchemaInfoDialog />
      <ValidationDialog />
      <ExportPdfDialog />
      <ConsolidationDialog />
      <ReviewerPrompt />
      <PersonPicker />
      <RepoSetupPrompt />
      <RepoSetupToast />
      <AgreementDialog />
      <ConsolidationOverview />
      <DisagreementOverview />
      <ClosePrompt />
      <ConsolidationUpdatePrompt />
      <AiDialog />
      <AiScreeningDialog />
      <LlmSettingsDialog />
      <ScreeningSummary />
      <ScreeningImportDialog />
      <DuplicateReviewDialog />
      <GitCloneDialog />
      <GitDialog />
      <GitMergeDialog />
      <StaleSaveDialog />
      <SplitAnnotationsDialog />
      <BranchSwitchPrompt />
      <NewBranchPrompt />
      <MergeBranchPrompt />
      <DeleteBranchPrompt />
      <GitHistoryDialog />
    </div>
  )
}
