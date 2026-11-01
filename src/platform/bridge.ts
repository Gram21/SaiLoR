import type { SharedAnnotations } from './adapter'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse, WebFetchResult } from '../llm/types'
import type { PullProgress } from '../llm/ollama'
import type { LocalServerResult, OllamaApi } from './ollamaApi'
import type { LocalRuntimeApi } from './localRuntime'
import type {
  GitProbe,
  CloneOutcome,
  GitRepoInfo,
  GitRun,
  PullStart,
  MergeStart,
  SplitProject,
  GitBranch,
  BranchSwitchStart,
  LogBeginResult,
  LogRevisionFetch,
  AnnotationAuthors,
  RepoSetupStatus,
  StashEntry,
  StashRestoreResult,
} from '../git/types'

/** Backend API: `window.slr` from electron/preload.ts, or the Tauri bridge in `./tauri`. */
export interface SlrBridge {
  /** The machine this build is running on (Node names: process.platform / process.arch). */
  os?: { platform: string; arch: string }
  openProject(): Promise<{ path: string; text: string; corrupt: string[] } | null>
  /** Read a specific file by absolute path (for recent files). Null if missing. */
  openPath(path: string): Promise<{ path: string; text: string; corrupt: string[] } | null>
  /** `metaText` is null when `project.json` itself is unchanged — see `lastWritten`.
   *  Writes nothing and names the files when any changed on disk since last read or written. */
  saveProject(
    path: string,
    metaText: string | null,
    files: Array<{ relPath: string; text: string | null }>,
  ): Promise<{ stale: string[] }>
  /** Register the project's base directory so slr-file:// can resolve PDFs. */
  setProjectDir(path: string): Promise<void>
  /** Pick a location for a project JSON without writing it. Null if cancelled. */
  pickSavePath(suggestedName: string): Promise<{ path: string } | null>
  annotationsDirUsers(projectPath: string, folder: string, paperIds: string[], screening: boolean): Promise<string[]>
  sharedAnnotations(projectPath: string): Promise<SharedAnnotations | null>
  moveAnnotationsDir(projectPath: string, folder: string): Promise<void>
  writeFeedback(projectPath: string, fileName: string, content: string): Promise<string>
  listFeedback(projectPath: string): Promise<{ name: string; bytes: number }[]>
  screeningSource(projectPath: string): Promise<{ name: string; text: string } | null>
  splitAnnotations(
    projectPath: string,
    plan: { folders: Record<string, string>; rows: { relPath: string; targets: string[] }[] },
  ): Promise<void>
  /** Pick PDFs to reference. Returns their absolute paths, [] if cancelled. */
  pickPdfs(): Promise<string[]>
  /** Pick a folder; returns the absolute paths of every PDF inside it (recursively). [] if cancelled. */
  pickPdfFolder(): Promise<string[]>
  /** Pick a .bib/.ris/.json reference file. Null if cancelled. */
  pickReferenceFile(): Promise<{ text: string; name: string } | null>
  /** Raw bytes of a PDF by absolute path (for reading its title/authors). */
  readPdf(path: string): Promise<Uint8Array>
  /** Same traversal/symlink guard `registerPdfProtocol` enforces when serving the file,
   *  checked first so a blocked/missing PDF gets an honest reason instead of pdf.js's opaque failure. */
  checkPdfPath(rel: string): Promise<{ ok: true } | { ok: false; reason: 'no-project' | 'escapes' | 'not-found' }>
  /** Asks the reviewer (native dialog in main process) whether to open `rel` despite it
   *  pointing outside the project folder; approval is remembered for the session — see `allowedEscapes` in electron/main.ts. */
  allowPdfPath(rel: string): Promise<boolean>
  /** Burn `marks` into the PDF at `pdfAbsPath` as real annotation objects. */
  embedPdfMarks(
    pdfAbsPath: string,
    marks: unknown,
    target: 'original' | { newPath: string },
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  /** Pick where a new annotated PDF should be saved. Null if cancelled. */
  pickPdfExportPath(suggestedName: string): Promise<string | null>
  /** Pick where a plain-text export should be saved. Null if cancelled. */
  pickTextExportPath(suggestedName: string): Promise<string | null>
  /** Write `text` to `absPath`. */
  writeTextFile(absPath: string, text: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  /** For each project path: does it still exist, and what title does it now carry? */
  peekProjects(paths: string[]): Promise<{ exists: boolean; title?: string }[]>
  /** Paths of `toFiles` relative to `fromFile`'s directory, POSIX-separated. */
  relativePaths(fromFile: string, toFiles: string[]): Promise<string[]>
  /** `rels` (relative to `fromFile`'s dir) re-expressed relative to `toFile`'s dir. */
  rebasePaths(fromFile: string, toFile: string, rels: string[]): Promise<string[]>
  /** Absolute paths for `rels`, which are relative to `fromFile`'s directory. */
  absolutePaths(fromFile: string, rels: string[]): Promise<string[]>
  /** The path `fileName` would have if it sat next to `sourceFile`. */
  siblingPath(sourceFile: string, fileName: string): Promise<string>
  /** AI targets. There is deliberately no way to read a stored API key back. */
  llmConfigs(): Promise<LlmConfig[]>
  saveLlmConfig(config: Omit<LlmConfig, 'hasKey'>, apiKey?: string): Promise<LlmConfig[]>
  deleteLlmConfig(id: string): Promise<LlmConfig[]>
  callLlm(requestId: string, request: LlmHttpRequest): Promise<LlmHttpResponse>
  abortLlm(requestId: string): void
  fetchWeb(requestId: string, url: string): Promise<WebFetchResult>
  abortWeb(requestId: string): void
  ollama: {
    version: OllamaApi['version']
    list: OllamaApi['list']
    show: OllamaApi['show']
    ps: OllamaApi['ps']
    pull(requestId: string, baseUrl: string, model: string): ReturnType<OllamaApi['pull']>
    cancelPull(requestId: string): void
    onPullProgress(cb: (p: PullProgress & { requestId: string }) => void): () => void
    delete: OllamaApi['delete']
    manifestSize: OllamaApi['manifestSize']
  }
  discoverLocalServer(baseUrl: string): Promise<LocalServerResult>
  local: LocalRuntimeApi
  /** Unsaved-changes coordination for a clean quit. */
  setDirty(dirty: boolean): void
  onRequestSave(cb: () => void): void
  saveComplete(ok: boolean): void
  /** Edit-menu Undo/Redo routed to the app's annotation history. */
  onUndo(cb: () => void): void
  onRedo(cb: () => void): void

  // Git: the user's own git binary. See `PlatformAdapter.getGit`.
  gitProbe(): Promise<GitProbe>
  gitPickCloneDir(): Promise<string | null>
  gitClone(url: string, dest: string): Promise<CloneOutcome>
  gitPickProjectIn(dir: string): Promise<string | null>
  gitInfo(projectPath: string): Promise<GitRepoInfo | null>
  /** Raw porcelain/diff text — parsed on this side of the IPC boundary
   *  (`src/git/output.ts`), where the parser is unit-tested. */
  gitStatus(root: string): Promise<{ porcelain: string; diff: string }>
  gitCommit(root: string, paths: string[], message: string, amend: boolean): Promise<GitRun>
  gitLastCommitMessage(root: string): Promise<string | null>
  gitPush(root: string): Promise<GitRun>
  gitPullBegin(root: string, relPath: string): Promise<PullStart>
  gitPullFinish(root: string, relPath: string, working: SplitProject): Promise<GitRun>
  gitPullAbort(root: string): Promise<GitRun>
  gitMergeBegin(root: string, relPath: string, ref: string): Promise<MergeStart>
  gitLogBegin(root: string, relPath: string): Promise<LogBeginResult>
  gitLogDiff(root: string, relPath: string, rev: string): Promise<LogRevisionFetch>
  gitHeadContent(root: string, relPath: string): Promise<string | null>
  gitWorkingContent(root: string, relPath: string): Promise<string | null>
  gitCommitPartial(
    root: string,
    relPath: string,
    committed: SplitProject,
    working: SplitProject,
    otherPaths: string[],
    message: string,
    amend: boolean,
  ): Promise<GitRun>
  gitWriteWorking(root: string, relPath: string, working: SplitProject): Promise<GitRun>
  gitDiscardFile(root: string, relPath: string, projectRelPath: string): Promise<GitRun>
  gitAnnotationAuthors(root: string, relPath: string): Promise<AnnotationAuthors>
  gitRepoSetupStatus(root: string, relPath: string): Promise<RepoSetupStatus>
  gitApplyRepoSetup(root: string, relPath: string): Promise<GitRun>
  gitBackgroundFetch(root: string): Promise<{ fetched: boolean; refused: boolean }>
  gitStashList(root: string): Promise<StashEntry[]>
  gitStashPush(root: string, relPath: string, message: string): Promise<GitRun>
  gitStashRestore(root: string, relPath: string, sha: string): Promise<StashRestoreResult>
  gitStashDrop(root: string, sha: string): Promise<GitRun>
  gitStashBranch(root: string, relPath: string, sha: string, branch: string): Promise<GitRun>
  gitBranches(root: string): Promise<GitBranch[]>
  gitBranchCreate(root: string, name: string): Promise<GitRun>
  gitBranchDelete(root: string, branch: string): Promise<GitRun>
  gitCheckout(root: string, branch: string): Promise<GitRun>
  gitBranchSwitchBegin(root: string, relPath: string, branch: string): Promise<BranchSwitchStart>
  gitBranchSwitchFinish(root: string, relPath: string, resolved: SplitProject): Promise<GitRun>
  gitBranchSwitchAbort(root: string, sourceBranch: string): Promise<GitRun>

  // Self-update. Electron: Windows/Linux only (main.ts is a no-op on darwin).
  // Tauri: where the bundle can self-update (src-tauri/src/update.rs). Download
  // and install are only ever triggered by the two calls below, never on their own.
  checkForNativeUpdate(): Promise<{ supported: boolean }>
  downloadNativeUpdate(): Promise<void>
  installNativeUpdate(): Promise<void>
  onNativeUpdateAvailable(cb: (info: { version: string }) => void): void
  onNativeUpdateProgress(cb: (p: { percent: number }) => void): void
  onNativeUpdateDownloaded(cb: () => void): void
  onNativeUpdateError(cb: (message: string) => void): void
}

let injected: SlrBridge | null = null

/** Route every bridge call through `bridge` instead of `window.slr`. */
export function setBridge(bridge: SlrBridge | null): void {
  injected = bridge
}

export function getBridge(): SlrBridge {
  return injected ?? (window as unknown as { slr: SlrBridge }).slr
}
