import { contextBridge, ipcRenderer } from 'electron'

/**
 * Safe bridge exposed to the renderer as `window.slr`. Mirrors the SlrBridge
 * interface in src/platform/electron.ts.
 */
contextBridge.exposeInMainWorld('slr', {
  // So the update notice can offer the installer that actually matches this
  // machine (e.g. the arm64 dmg rather than the Intel one).
  os: { platform: process.platform, arch: process.arch },

  openProject: () => ipcRenderer.invoke('project:open'),
  openPath: (filePath: string) => ipcRenderer.invoke('project:openPath', filePath),
  saveProject: (filePath: string, metaText: string, files: Array<{ relPath: string; text: string | null }>) =>
    ipcRenderer.invoke('project:save', filePath, metaText, files),
  setProjectDir: (filePath: string) => ipcRenderer.invoke('project:setDir', filePath),

  // Project editor: pick a location / PDFs, and relativize the PDF references.
  pickSavePath: (suggestedName: string) => ipcRenderer.invoke('project:pickSavePath', suggestedName),
  pickPdfs: () => ipcRenderer.invoke('pdf:pick'),
  pickPdfFolder: () => ipcRenderer.invoke('pdf:pickFolder'),
  pickReferenceFile: () => ipcRenderer.invoke('reference:pick'),
  readPdf: (filePath: string) => ipcRenderer.invoke('pdf:read', filePath),
  checkPdfPath: (rel: string) => ipcRenderer.invoke('pdf:checkPath', rel),
  allowPdfPath: (rel: string) => ipcRenderer.invoke('pdf:allowPath', rel),
  embedPdfMarks: (pdfAbsPath: string, marks: unknown, target: 'original' | { newPath: string }) =>
    ipcRenderer.invoke('pdf:embedMarks', pdfAbsPath, marks, target),
  pickPdfExportPath: (suggestedName: string) => ipcRenderer.invoke('pdf:pickExportPath', suggestedName),
  pickTextExportPath: (suggestedName: string) => ipcRenderer.invoke('text:pickExportPath', suggestedName),
  writeTextFile: (absPath: string, text: string) => ipcRenderer.invoke('text:write', absPath, text),
  peekProjects: (paths: string[]) => ipcRenderer.invoke('project:peek', paths),
  relativePaths: (fromFile: string, toFiles: string[]) =>
    ipcRenderer.invoke('paths:relative', fromFile, toFiles),
  rebasePaths: (fromFile: string, toFile: string, rels: string[]) =>
    ipcRenderer.invoke('paths:rebase', fromFile, toFile, rels),
  absolutePaths: (fromFile: string, rels: string[]) =>
    ipcRenderer.invoke('paths:absolute', fromFile, rels),
  siblingPath: (sourceFile: string, fileName: string) =>
    ipcRenderer.invoke('paths:sibling', sourceFile, fileName),

  // AI-assisted annotation. Note what is NOT here: any way to read an API key
  // back out. The renderer can store one and use one, but never see one.
  llmConfigs: () => ipcRenderer.invoke('llm:configs'),
  saveLlmConfig: (config: unknown, apiKey?: string) =>
    ipcRenderer.invoke('llm:saveConfig', config, apiKey),
  deleteLlmConfig: (id: string) => ipcRenderer.invoke('llm:deleteConfig', id),
  callLlm: (requestId: string, request: unknown) =>
    ipcRenderer.invoke('llm:call', requestId, request),
  abortLlm: (requestId: string) => ipcRenderer.send('llm:abort', requestId),

  // Unsaved-changes coordination for a clean quit.
  setDirty: (dirty: boolean) => ipcRenderer.send('app:setDirty', dirty),
  onRequestSave: (cb: () => void) => {
    ipcRenderer.removeAllListeners('app:requestSave')
    ipcRenderer.on('app:requestSave', () => cb())
  },
  saveComplete: (ok: boolean) => ipcRenderer.send('app:saveComplete', ok),

  // Edit-menu Undo/Redo, routed to the app's annotation history.
  onUndo: (cb: () => void) => {
    ipcRenderer.removeAllListeners('app:undo')
    ipcRenderer.on('app:undo', () => cb())
  },
  onRedo: (cb: () => void) => {
    ipcRenderer.removeAllListeners('app:redo')
    ipcRenderer.on('app:redo', () => cb())
  },

  // Git: the user's own git binary. Desktop only — a browser page cannot spawn
  // one; see `PlatformAdapter.getGit()`.
  gitProbe: () => ipcRenderer.invoke('git:probe'),
  gitPickCloneDir: () => ipcRenderer.invoke('git:pickCloneDir'),
  gitClone: (url: string, dest: string) => ipcRenderer.invoke('git:clone', url, dest),
  gitPickProjectIn: (dir: string) => ipcRenderer.invoke('git:pickProjectIn', dir),
  gitInfo: (projectPath: string) => ipcRenderer.invoke('git:info', projectPath),
  gitStatus: (root: string) => ipcRenderer.invoke('git:status', root),
  gitCommit: (root: string, paths: string[], message: string) =>
    ipcRenderer.invoke('git:commit', root, paths, message),
  gitPush: (root: string) => ipcRenderer.invoke('git:push', root),
  gitPullBegin: (root: string, relPath: string) => ipcRenderer.invoke('git:pullBegin', root, relPath),
  gitPullFinish: (root: string, relPath: string, working: unknown) =>
    ipcRenderer.invoke('git:pullFinish', root, relPath, working),
  gitPullAbort: (root: string) => ipcRenderer.invoke('git:pullAbort', root),
  gitBranches: (root: string) => ipcRenderer.invoke('git:branches', root),
  gitBranchCreate: (root: string, name: string) => ipcRenderer.invoke('git:branchCreate', root, name),
  gitCheckout: (root: string, branch: string) => ipcRenderer.invoke('git:checkout', root, branch),
  gitBranchSwitchBegin: (root: string, relPath: string, branch: string) =>
    ipcRenderer.invoke('git:branchSwitchBegin', root, relPath, branch),
  gitBranchSwitchFinish: (root: string, relPath: string, resolved: unknown) =>
    ipcRenderer.invoke('git:branchSwitchFinish', root, relPath, resolved),
  gitBranchSwitchAbort: (root: string, sourceBranch: string) =>
    ipcRenderer.invoke('git:branchSwitchAbort', root, sourceBranch),
  gitHeadContent: (root: string, relPath: string) => ipcRenderer.invoke('git:headContent', root, relPath),
  gitWorkingContent: (root: string, relPath: string) => ipcRenderer.invoke('git:workingContent', root, relPath),
  gitCommitPartial: (
    root: string,
    relPath: string,
    committed: unknown,
    working: unknown,
    otherPaths: string[],
    message: string,
  ) => ipcRenderer.invoke('git:commitPartial', root, relPath, committed, working, otherPaths, message),
  gitWriteWorking: (root: string, relPath: string, working: unknown) =>
    ipcRenderer.invoke('git:writeWorking', root, relPath, working),

  // Self-update (Windows/Linux only — see electron/main.ts). Download/install
  // are only ever triggered by these two explicit calls, never on their own.
  checkForNativeUpdate: () => ipcRenderer.invoke('update:check'),
  downloadNativeUpdate: () => ipcRenderer.invoke('update:download'),
  installNativeUpdate: () => ipcRenderer.invoke('update:install'),
  onNativeUpdateAvailable: (cb: (info: { version: string }) => void) => {
    ipcRenderer.removeAllListeners('update:available')
    ipcRenderer.on('update:available', (_e, info) => cb(info))
  },
  onNativeUpdateProgress: (cb: (p: { percent: number }) => void) => {
    ipcRenderer.removeAllListeners('update:progress')
    ipcRenderer.on('update:progress', (_e, p) => cb(p))
  },
  onNativeUpdateDownloaded: (cb: () => void) => {
    ipcRenderer.removeAllListeners('update:downloaded')
    ipcRenderer.on('update:downloaded', () => cb())
  },
  onNativeUpdateError: (cb: (message: string) => void) => {
    ipcRenderer.removeAllListeners('update:error')
    ipcRenderer.on('update:error', (_e, message) => cb(message))
  },
})
