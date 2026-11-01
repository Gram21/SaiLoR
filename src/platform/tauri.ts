import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { setBridge, type SlrBridge } from './bridge'
import { ElectronAdapter } from './electron'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => any

const named = (names: string[], args: unknown[]) => Object.fromEntries(names.map((n, i) => [n, args[i]]))

const call =
  (channel: string, ...names: string[]): Fn =>
  (...args) =>
    invoke(channel, named(names, args))

const send =
  (channel: string, ...names: string[]): Fn =>
  (...args) => {
    invoke(channel, named(names, args)).catch(() => {})
  }

const subscribe =
  (event: string): Fn =>
  (cb) => {
    const off = listen(event, (e) => cb(e.payload))
    return () => void off.then((f) => f())
  }

const replaced = new Map<string, Promise<UnlistenFn>>()
const replace =
  (event: string): Fn =>
  (cb) => {
    void replaced.get(event)?.then((f) => f())
    replaced.set(event, listen(event, (e) => cb(e.payload)))
  }

/**
 * `window.slr` over Tauri IPC: one entry per electron/preload.ts method, same
 * channel names as Tauri command/event names, positional args sent as named
 * fields. Commands not yet implemented in Rust reject.
 */
export const tauriBridge: SlrBridge = {
  openProject: call('project:open'),
  openPath: call('project:openPath', 'filePath'),
  saveProject: call('project:save', 'filePath', 'metaText', 'files'),
  setProjectDir: call('project:setDir', 'filePath'),

  pickSavePath: call('project:pickSavePath', 'suggestedName'),
  annotationsDirUsers: call('project:annotationsDirUsers', 'projectPath', 'folder', 'paperIds', 'screening'),
  sharedAnnotations: call('project:sharedAnnotations', 'projectPath'),
  screeningSource: call('project:screeningSource', 'projectPath'),
  moveAnnotationsDir: call('project:moveAnnotationsDir', 'projectPath', 'folder'),
  writeFeedback: call('project:writeFeedback', 'projectPath', 'fileName', 'content'),
  listFeedback: call('project:listFeedback', 'projectPath'),
  splitAnnotations: call('project:splitAnnotations', 'projectPath', 'plan'),
  pickPdfs: call('pdf:pick'),
  pickPdfFolder: call('pdf:pickFolder'),
  pickReferenceFile: call('reference:pick'),
  // Rust returns bytes as ArrayBuffer (ipc::Response) or number[] (Vec<u8>); callers expect a Uint8Array.
  readPdf: async (filePath: string) => new Uint8Array(await invoke<ArrayBuffer | number[]>('pdf:read', { filePath })),
  checkPdfPath: call('pdf:checkPath', 'rel'),
  allowPdfPath: call('pdf:allowPath', 'rel'),
  embedPdfMarks: call('pdf:embedMarks', 'pdfAbsPath', 'marks', 'target'),
  pickPdfExportPath: call('pdf:pickExportPath', 'suggestedName'),
  pickTextExportPath: call('text:pickExportPath', 'suggestedName'),
  writeTextFile: call('text:write', 'absPath', 'text'),
  peekProjects: call('project:peek', 'paths'),
  relativePaths: call('paths:relative', 'fromFile', 'toFiles'),
  rebasePaths: call('paths:rebase', 'fromFile', 'toFile', 'rels'),
  absolutePaths: call('paths:absolute', 'fromFile', 'rels'),
  siblingPath: call('paths:sibling', 'sourceFile', 'fileName'),

  llmConfigs: call('llm:configs'),
  saveLlmConfig: call('llm:saveConfig', 'config', 'apiKey'),
  deleteLlmConfig: call('llm:deleteConfig', 'id'),
  callLlm: call('llm:call', 'requestId', 'request'),
  abortLlm: send('llm:abort', 'requestId'),
  fetchWeb: call('web:fetch', 'requestId', 'url'),
  abortWeb: send('web:abort', 'requestId'),

  ollama: {
    version: call('ollama:version', 'baseUrl'),
    list: call('ollama:list', 'baseUrl'),
    show: call('ollama:show', 'baseUrl', 'model', 'numCtx'),
    ps: call('ollama:ps', 'baseUrl'),
    pull: call('ollama:pull', 'requestId', 'baseUrl', 'model'),
    cancelPull: send('ollama:cancelPull', 'requestId'),
    onPullProgress: subscribe('ollama:pullProgress'),
    delete: call('ollama:delete', 'baseUrl', 'model'),
    manifestSize: call('ollama:manifestSize', 'model'),
  },
  discoverLocalServer: call('localserver:discover', 'baseUrl'),

  local: {
    probe: call('local:probe'),
    runtime: call('local:runtime'),
    runtimePlan: call('local:runtimePlan'),
    runtimeInstall: call('local:runtimeInstall'),
    modelPlan: call('local:modelPlan', 'id'),
    modelInstall: call('local:modelInstall', 'id'),
    cancel: call('local:cancel', 'id'),
    installed: call('local:installed'),
    remove: call('local:remove', 'id'),
    start: call('local:start', 'id'),
    stop: call('local:stop', 'id'),
    status: call('local:status'),
    logs: call('local:logs', 'id'),
    onProgress: subscribe('local:progress'),
  },

  setDirty: send('app:setDirty', 'dirty'),
  onRequestSave: replace('app:requestSave'),
  saveComplete: send('app:saveComplete', 'ok'),
  onUndo: replace('app:undo'),
  onRedo: replace('app:redo'),

  gitProbe: call('git:probe'),
  gitPickCloneDir: call('git:pickCloneDir'),
  gitClone: call('git:clone', 'url', 'dest'),
  gitPickProjectIn: call('git:pickProjectIn', 'dir'),
  gitInfo: call('git:info', 'projectPath'),
  gitStatus: call('git:status', 'root'),
  gitCommit: call('git:commit', 'root', 'paths', 'message', 'amend'),
  gitLastCommitMessage: call('git:lastCommitMessage', 'root'),
  gitPush: call('git:push', 'root'),
  gitPullBegin: call('git:pullBegin', 'root', 'relPath'),
  gitPullFinish: call('git:pullFinish', 'root', 'relPath', 'working'),
  gitPullAbort: call('git:pullAbort', 'root'),
  gitMergeBegin: call('git:mergeBegin', 'root', 'relPath', 'ref'),
  gitLogBegin: call('git:logBegin', 'root', 'relPath'),
  gitLogDiff: call('git:logDiff', 'root', 'relPath', 'rev'),
  gitAnnotationAuthors: call('git:annotationAuthors', 'root', 'relPath'),
  gitRepoSetupStatus: call('git:repoSetupStatus', 'root', 'relPath'),
  gitApplyRepoSetup: call('git:applyRepoSetup', 'root', 'relPath'),
  gitBackgroundFetch: call('git:backgroundFetch', 'root'),
  gitStashList: call('git:stashList', 'root'),
  gitStashPush: call('git:stashPush', 'root', 'relPath', 'message'),
  gitStashRestore: call('git:stashRestore', 'root', 'relPath', 'sha'),
  gitStashDrop: call('git:stashDrop', 'root', 'sha'),
  gitStashBranch: call('git:stashBranch', 'root', 'relPath', 'sha', 'branch'),
  gitBranches: call('git:branches', 'root'),
  gitBranchCreate: call('git:branchCreate', 'root', 'name'),
  gitBranchDelete: call('git:branchDelete', 'root', 'branch'),
  gitCheckout: call('git:checkout', 'root', 'branch'),
  gitBranchSwitchBegin: call('git:branchSwitchBegin', 'root', 'relPath', 'branch'),
  gitBranchSwitchFinish: call('git:branchSwitchFinish', 'root', 'relPath', 'resolved'),
  gitBranchSwitchAbort: call('git:branchSwitchAbort', 'root', 'sourceBranch'),
  gitHeadContent: call('git:headContent', 'root', 'relPath'),
  gitWorkingContent: call('git:workingContent', 'root', 'relPath'),
  gitCommitPartial: call('git:commitPartial', 'root', 'relPath', 'committed', 'working', 'otherPaths', 'message', 'amend'),
  gitWriteWorking: call('git:writeWorking', 'root', 'relPath', 'working'),
  gitDiscardFile: call('git:discardFile', 'root', 'relPath', 'projectRelPath'),

  checkForNativeUpdate: call('update:check'),
  downloadNativeUpdate: call('update:download'),
  installNativeUpdate: call('update:install'),
  onNativeUpdateAvailable: replace('update:available'),
  onNativeUpdateProgress: replace('update:progress'),
  onNativeUpdateDownloaded: replace('update:downloaded'),
  onNativeUpdateError: replace('update:error'),
}

/** The Electron adapter's renderer logic over the Tauri transport. */
export class TauriAdapter extends ElectronAdapter {
  constructor() {
    super()
    setBridge(tauriBridge)
  }
}
