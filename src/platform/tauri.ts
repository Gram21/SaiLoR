import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { setBridge, type SlrBridge } from './bridge'
import { DesktopAdapter } from './desktop'
import { assembler, type RawProject } from './assemble'
import { offMain } from './offMain'

export type { RawProject }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => any

// [impl->req~dat-172~1]
// [impl->req~plt-40~1]
/**
 * Turns what Rust read into the whole-project text `loadProject` accepts. A file that does not
 * parse counts as absent and its path goes to `corrupt`.
 */
export function assembleProject(p: RawProject, corrupt: string[] = []): string {
  return assembler(p, corrupt)?.(p.files, corrupt) ?? p.text
}

// [impl->req~plt-440~1]
/**
 * Rust opens only `project.json`; `text` is every paper's metadata without annotations, and
 * `readPapers` reads and assembles the named papers' files (every paper when `ids` is omitted).
 */
let sessionCount = 0
const opened = async (o: RawProject | null) => {
  if (!o) return null
  const session = ++sessionCount
  const head = await offMain<'open'>({ kind: 'open', session, text: o.text, siblings: o.siblings })
  if (head.legacy) return { path: o.path, text: o.text, corrupt: head.corrupt }
  const readPapers = async (ids?: string[]) => {
    const files = await tauriBridge.readPapers(o.path!, ids ?? head.ids)
    return offMain<'read'>({ kind: 'read', session, files, ids })
  }
  return { path: o.path, text: head.text, corrupt: head.corrupt, readPapers }
}

const snapshot = (s: RawProject | null) => (s ? assembleProject(s) : null)

const merged = (r: { kind: string; base: RawProject | null; ours: RawProject; theirs: RawProject } | undefined) =>
  r?.kind === 'merge' ? { ...r, base: snapshot(r.base), ours: assembleProject(r.ours), theirs: assembleProject(r.theirs) } : r

const then =
  (f: Fn, g: Fn): Fn =>
  async (...args) =>
    g(await f(...args))

const named = (names: string[], args: unknown[]) => Object.fromEntries(names.map((n, i) => [n, args[i]]))

// [impl->req~plt-230~1]
export const command = (channel: string) =>
  channel.replace(':', '_').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

const call =
  (channel: string, ...names: string[]): Fn =>
  (...args) =>
    invoke(command(channel), named(names, args))

const send =
  (channel: string, ...names: string[]): Fn =>
  (...args) => {
    invoke(command(channel), named(names, args)).catch(() => {})
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

// [impl->req~llm-722~1]
// [impl->req~plt-230~1]
/**
 * The backend API over Tauri IPC: one entry per `SlrBridge` method, channel
 * names mapped to Tauri command/event names, positional args sent as named
 * fields. Commands not yet implemented in Rust reject.
 */
export const tauriBridge: SlrBridge = {
  /** Set by the `slr-os` init script in src-tauri/src/main.rs. */
  get os() {
    return (globalThis as { __SLR_OS__?: { platform: string; arch: string } }).__SLR_OS__
  },
  openProject: then(call('project:open'), opened),
  openPath: then(call('project:openPath', 'filePath'), opened),
  readPapers: call('project:readPapers', 'filePath', 'ids'),
  saveProject: call('project:save', 'filePath', 'metaText', 'files'),
  setProjectDir: call('project:setDir', 'filePath'),

  pickSavePath: call('project:pickSavePath', 'suggestedName'),
  annotationsDirUsers: call('project:annotationsDirUsers', 'projectPath', 'folder', 'paperIds', 'screening'),
  sharedAnnotations: call('project:sharedAnnotations', 'projectPath'),
  screeningSource: then(call('project:screeningSource', 'projectPath'), (r: (RawProject & { name: string }) | null) =>
    r ? { name: r.name, text: assembleProject(r) } : null,
  ),
  moveAnnotationsDir: call('project:moveAnnotationsDir', 'projectPath', 'folder'),
  writeFeedback: call('project:writeFeedback', 'projectPath', 'fileName', 'content'),
  listFeedback: call('project:listFeedback', 'projectPath'),
  splitAnnotations: call('project:splitAnnotations', 'projectPath', 'plan'),
  pickPdfs: call('pdf:pick'),
  pickPdfFolder: call('pdf:pickFolder'),
  pickReferenceFile: call('reference:pick'),
  // Rust returns bytes as ArrayBuffer (ipc::Response) or number[] (Vec<u8>); callers expect a Uint8Array.
  readSystemFont: async (index: number) => new Uint8Array(await invoke<ArrayBuffer | number[]>('pdf_system_font', { index })),
  readPdf: async (filePath: string) => new Uint8Array(await invoke<ArrayBuffer | number[]>('pdf_read', { filePath })),
  checkPdfPath: call('pdf:checkPath', 'rel'),
  scanPdfFolder: call('pdf:scanFolder', 'folder', 'known'),
  allowPdfPath: call('pdf:allowPath', 'rel'),
  embedPdfMarks: call('pdf:embedMarks', 'pdfAbsPath', 'marks', 'target'),
  pickPdfExportPath: call('pdf:pickExportPath', 'suggestedName'),
  pickTextExportPath: call('text:pickExportPath', 'suggestedName', 'extension'),
  writeTextFile: call('text:write', 'absPath', 'text'),
  writeBinaryFile: call('export:writeBytes', 'absPath', 'bytes'),
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

  // [impl->req~ui-25~1]
  setWindowTitle: (title: string) => {
    getCurrentWindow()
      .setTitle(title)
      .catch(() => {})
  },
  setDirty: send('app:setDirty', 'dirty'),
  onRequestSave: replace('app:requestSave'),
  saveComplete: send('app:saveComplete', 'ok'),
  onUndo: replace('app:undo'),
  onRedo: replace('app:redo'),
  // [impl->req~plt-120~1]
  requestReload: send('app:reload'),
  onCloseProject: replace('app:closeProject'),
  // [impl->req~ui-100~1]
  onOpenSettings: replace('app:settings'),
  // [impl->req~plt-400~1]
  setLanguage: send('app:setLanguage', 'lang'),

  gitProbe: call('git:probe'),
  gitPickCloneDir: call('git:pickCloneDir'),
  gitClone: call('git:clone', 'url', 'dest'),
  gitPickProjectIn: call('git:pickProjectIn', 'dir'),
  gitInfo: call('git:info', 'projectPath'),
  gitStatus: call('git:status', 'root'),
  gitCommit: call('git:commit', 'root', 'paths', 'message', 'amend'),
  gitLastCommitMessage: call('git:lastCommitMessage', 'root'),
  gitPush: call('git:push', 'root'),
  gitPullBegin: then(call('git:pullBegin', 'root', 'relPath'), merged),
  gitPullFinish: call('git:pullFinish', 'root', 'relPath', 'working'),
  gitPullAbort: call('git:pullAbort', 'root'),
  gitMergeBegin: then(call('git:mergeBegin', 'root', 'relPath', 'ref'), merged),
  gitMergePreview: call('git:mergePreview', 'root', 'relPath', 'ref'),
  gitUndoMerge: call('git:undoMerge', 'root', 'relPath'),
  gitLogBegin: call('git:logBegin', 'root', 'relPath'),
  gitLogDiff: then(call('git:logDiff', 'root', 'relPath', 'rev'), (r) =>
    r?.kind === 'texts' ? { ...r, head: assembleProject(r.head), parent: assembleProject(r.parent) } : r,
  ),
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
  gitBranchSwitchBegin: then(call('git:branchSwitchBegin', 'root', 'relPath', 'branch'), merged),
  gitBranchSwitchFinish: call('git:branchSwitchFinish', 'root', 'relPath', 'resolved'),
  gitBranchSwitchAbort: call('git:branchSwitchAbort', 'root', 'sourceBranch'),
  gitHeadContent: then(call('git:headContent', 'root', 'relPath'), snapshot),
  gitWorkingContent: then(call('git:workingContent', 'root', 'relPath'), snapshot),
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

/** The desktop adapter's renderer logic over the Tauri transport. */
export class TauriAdapter extends DesktopAdapter {
  constructor() {
    super()
    setBridge(tauriBridge)
  }
}
