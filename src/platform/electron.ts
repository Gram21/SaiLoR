import type {
  OpenedProject,
  OsInfo,
  PdfSource,
  PickedPdf,
  PlatformAdapter,
  ProjectLocation,
  SaveHandle,
} from './adapter'
import { StaleSaveError, type SharedAnnotations } from './adapter'
import { readRecents, pushRecent, removeRecent, replaceRecents, type RecentEntry } from './recents'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse } from '../llm/types'
import type {
  GitPlatform,
  GitProbe,
  CloneOutcome,
  GitRepoInfo,
  GitStatus,
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
import { parsePorcelain, capDiff } from '../git/output'
import { loadProject, projectFromFiles, splitProjectFiles, type ProjectFileEntry } from '../model/project'
import type { PdfMark } from '../model/pdfMarks'

const RECENTS_KEY = 'slr.recents.electron'

/**
 * How the open project's files last stood on disk — `project.json`'s text plus
 * every `annotations/…` entry, keyed by relative path. A save writes only what
 * differs from this.
 *
 * Without it, every save rewrites every paper's file for every reviewer, so
 * adding a field to the schema (which `pruneTree` materializes as an empty
 * entry in every tree) turns one reviewer's edit into a diff across the whole
 * `annotations/` folder — files nobody touched, in a repository several people
 * share. Comparing against the serialization the project was *loaded* with
 * isolates exactly the papers edited since, without the store having to track
 * that per paper: `splitProjectFiles` is pure, so an untouched paper serializes
 * identically both times.
 *
 * Refreshed by every open (including the reloads git flows do after they
 * rewrite the working tree) and every save; a project at a different path
 * doesn't match, and writes everything.
 */
let lastWritten: { path: string; meta: string; files: Map<string, string | null> } | null = null

function noteWritten(path: string, meta: string, files: ProjectFileEntry[]): void {
  lastWritten = { path, meta, files: new Map(files.map((f) => [f.relPath, f.text])) }
}

/**
 * Run a call that may rewrite the working tree, forgetting the baseline first
 * so the next save writes every file rather than only what differs from it.
 *
 * The baseline describes what is on disk, and every git flow that rewrites the
 * working tree makes it a claim about a past that no longer exists. Those
 * flows do all reload the project afterwards, which sets a fresh one — but
 * that is an invariant a future flow can quietly break, and the failure would
 * be a save that skips a file it should have written. Dropping it at the seam
 * the writes actually pass through makes the safe outcome the automatic one:
 * a lost baseline costs one whole-tree write, a stale one costs data.
 */
function withBaselineDropped<T>(call: () => Promise<T>): Promise<T> {
  lastWritten = null
  return call()
}

/**
 * The baseline as it reads under `meta`'s schema version. A save that brings
 * a new version (the editor recorded a rename) carries every file's answers
 * to the new names on load; comparing against the old baseline would count
 * each of those files as edited and rewrite files nobody touched. Re-reading
 * the baseline under the new version makes a file differ only when its
 * content really changed — it is written under the new version then.
 */
function rebaselined(base: typeof lastWritten, meta: unknown): typeof lastWritten {
  if (!base) return base
  const versionOf = (m: unknown) => (m as { schemaVersion?: unknown } | null)?.schemaVersion
  try {
    if (versionOf(JSON.parse(base.meta)) === versionOf(meta)) return base
    const files = [...base.files].filter((e): e is [string, string] => e[1] !== null)
    const { files: moved } = splitProjectFiles(projectFromFiles(meta, files))
    return { ...base, files: new Map(moved.map((f) => [f.relPath, f.text])) }
  } catch {
    return null
  }
}

/** Record how `text` — a project just read from `path` — serializes, so the
 *  next save can tell edits apart from normalization. Unparseable text leaves
 *  no baseline, so that save writes everything, exactly as before. */
function noteOpened(path: string, text: string): void {
  try {
    const { meta, files } = splitProjectFiles(loadProject(text))
    noteWritten(path, JSON.stringify(meta, null, 2), files)
  } catch {
    lastWritten = null
  }
}

/** Shape of the API exposed by electron/preload.ts on `window.slr`. */
export interface SlrBridge {
  /** The machine this build is running on (from process.platform / process.arch). */
  os: { platform: string; arch: string }
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
  annotationsDirUsers(projectPath: string, folder: string): Promise<string[]>
  sharedAnnotations(projectPath: string): Promise<SharedAnnotations | null>
  moveAnnotationsDir(projectPath: string, folder: string): Promise<void>
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

  // Self-update (Windows/Linux only — main.ts is a no-op on darwin). Download
  // and install are only ever triggered by the two calls below, never on their own.
  checkForNativeUpdate(): Promise<{ supported: boolean }>
  downloadNativeUpdate(): Promise<void>
  installNativeUpdate(): Promise<void>
  onNativeUpdateAvailable(cb: (info: { version: string }) => void): void
  onNativeUpdateProgress(cb: (p: { percent: number }) => void): void
  onNativeUpdateDownloaded(cb: () => void): void
  onNativeUpdateError(cb: (message: string) => void): void
}

function bridge(): SlrBridge {
  return (window as unknown as { slr: SlrBridge }).slr
}

/** Electron adapter: native dialogs + fs via IPC, PDFs via the slr-file:// protocol. */
export class ElectronAdapter implements PlatformAdapter {
  readonly kind = 'electron' as const

  getOsInfo(): OsInfo | null {
    return bridge().os ?? null
  }

  getRecents(): RecentEntry[] {
    return readRecents(RECENTS_KEY)
  }

  rememberProject(handle: SaveHandle, _name: string, title?: string): void {
    if (!handle.path) return
    // The absolute path is the id, so re-pushing just enriches the same entry.
    pushRecent(RECENTS_KEY, {
      id: handle.path,
      name: baseName(handle.path),
      path: handle.path,
      title,
    })
  }

  forgetRecent(id: string): RecentEntry[] {
    return removeRecent(RECENTS_KEY, id)
  }

  async checkRecents(entries: RecentEntry[]): Promise<RecentEntry[]> {
    if (entries.length === 0) return entries
    // The id IS the absolute path on Electron.
    const peeked = await bridge().peekProjects(entries.map((e) => e.id))
    const fresh = entries.map((e, i) => {
      const p = peeked[i]
      return {
        ...e,
        available: p?.exists ?? false,
        // Re-read from the file: the stored title goes stale once the project is renamed elsewhere.
        title: p?.exists ? p.title : e.title,
      }
    })
    replaceRecents(RECENTS_KEY, fresh)
    return fresh
  }

  async openProject(): Promise<OpenedProject | null> {
    const res = await bridge().openProject()
    if (!res) return null
    await bridge().setProjectDir(res.path)
    noteOpened(res.path, res.text)
    pushRecent(RECENTS_KEY, { id: res.path, name: baseName(res.path), path: res.path })
    return {
      text: res.text,
      handle: { kind: 'electron', path: res.path },
      name: baseName(res.path),
      corruptFiles: res.corrupt,
    }
  }

  async openRecent(id: string): Promise<OpenedProject | null> {
    const res = await bridge().openPath(id)
    // Keep the entry even if the file is gone — the drive may come back — caller marks it unavailable instead.
    if (!res) return null
    await bridge().setProjectDir(res.path)
    noteOpened(res.path, res.text)
    pushRecent(RECENTS_KEY, { id: res.path, name: baseName(res.path), path: res.path })
    return {
      text: res.text,
      handle: { kind: 'electron', path: res.path },
      name: baseName(res.path),
      corruptFiles: res.corrupt,
    }
  }

  async saveProject(text: string, handle: SaveHandle): Promise<SaveHandle> {
    if (!handle.path) throw new Error('No file path; use "Save as".')
    // `text` is the shared whole-project JSON contract; on disk this build splits it into
    // `project.json` (meta) plus per-tree `annotations/<paperId>/…` files — see `splitProjectFiles`.
    const { meta, files } = splitProjectFiles(loadProject(text))
    const metaText = JSON.stringify(meta, null, 2)
    // Only what actually changed — see `lastWritten`.
    const base = rebaselined(lastWritten?.path === handle.path ? lastWritten : null, meta)
    const changed = base
      ? files.filter((f) => !base.files.has(f.relPath) || base.files.get(f.relPath) !== f.text)
      : files
    // Paths the project used to write and no longer does: a paper removed from
    // the project, or one whose id was renamed (its files simply move to the
    // new id's folder). `splitProjectFiles` can't ask for their deletion — it
    // only describes the papers that still exist — and nothing else ever
    // revisited them, so `annotations/<gone>/` stayed on disk forever, got
    // committed, and silently re-attached itself to any paper later given the
    // same id.
    //
    // The baseline is what makes this safe to do at all. Scanning the folder
    // instead could not tell a removed paper of ours from a sibling project's
    // paper (see `ownAnnotationPathMatcher`) — both are "an id this project
    // doesn't have". The baseline only ever holds paths this project itself
    // read or wrote, so everything in it is ours by construction.
    const present = new Set(files.map((f) => f.relPath))
    const removed = base
      ? [...base.files.keys()].filter((p) => !present.has(p)).map((relPath) => ({ relPath, text: null }))
      : []
    const { stale } = await bridge().saveProject(handle.path, base?.meta === metaText ? null : metaText, [...changed, ...removed])
    if (stale.length > 0) throw new StaleSaveError(stale)
    noteWritten(handle.path, metaText, files)
    return handle
  }

  async rebasePdfPaths(pdfPaths: string[], from: SaveHandle, to: SaveHandle): Promise<string[]> {
    if (!from.path || !to.path || pdfPaths.length === 0) return pdfPaths
    return bridge().rebasePaths(from.path, to.path, pdfPaths)
  }

  async getPdfSource(pdfPath: string, projectHandle: SaveHandle): Promise<PdfSource> {
    // Re-assert the dir from this project's handle: the editor repoints it when picking a
    // new location, so trusting whatever was set last could resolve PDFs against the wrong dir.
    if (projectHandle?.path) await bridge().setProjectDir(projectHandle.path)
    // Check first so a bad path surfaces its real reason as a thrown Error, instead of
    // pdf.js's opaque generic failure for a 403/404 from the protocol handler.
    const check = await bridge().checkPdfPath(pdfPath)
    if (!check.ok) {
      if (check.reason === 'escapes') {
        // Not a hard refusal — the reviewer may trust this project enough to read outside its
        // folder (see `allowedEscapes` in electron/main.ts). The confirm dialog runs in the main
        // process so a renderer can't just approve its own escape.
        const approved = await bridge().allowPdfPath(pdfPath)
        if (!approved) {
          throw new Error(
            `PDF "${pdfPath}" was not opened — it points outside the project's own folder, and you chose not to open it.`,
          )
        }
      } else if (check.reason === 'not-found') {
        throw new Error(`PDF "${pdfPath}" was not found relative to the project's own folder.`)
      } else {
        throw new Error('No project is open.')
      }
    }
    // Carried as a query param, not the URL path: Chromium's URL parser collapses ".."
    // path segments per spec before the request is even made, so a path-based value would
    // silently climb to the wrong file. Query values aren't subject to that normalization.
    return { url: `slr-file://project/pdf?path=${encodeURIComponent(pdfPath)}` }
  }

  // Electron reads PDFs straight off disk via slr-file:// — there is no
  // folder-grant prompt to ask for.
  needsPdfFolderGrant(): boolean {
    return false
  }

  async grantPdfFolderAccess(): Promise<void> {}

  async pickProjectLocation(suggestedName: string): Promise<ProjectLocation | null> {
    const res = await bridge().pickSavePath(suggestedName)
    if (!res) return null
    // Point slr-file:// at the new project's directory so PDFs added in the
    // editor can already be previewed before the JSON is ever written.
    await bridge().setProjectDir(res.path)
    return {
      handle: { kind: 'electron', path: res.path },
      name: baseName(res.path),
      path: res.path,
    }
  }

  annotationsDirUsers(projectPath: string, folder: string): Promise<string[]> {
    return bridge().annotationsDirUsers(projectPath, folder)
  }

  sharedAnnotations(projectPath: string): Promise<SharedAnnotations | null> {
    return bridge().sharedAnnotations(projectPath)
  }

  moveAnnotationsDir(projectPath: string, folder: string): Promise<void> {
    return bridge().moveAnnotationsDir(projectPath, folder)
  }

  // Rewrites project files and moves annotation files, so what was last
  // written describes nothing any more.
  splitAnnotations(
    projectPath: string,
    plan: { folders: Record<string, string>; rows: { relPath: string; targets: string[] }[] },
  ): Promise<void> {
    return withBaselineDropped(() => bridge().splitAnnotations(projectPath, plan))
  }

  async pickPdfs(): Promise<PickedPdf[]> {
    const paths = await bridge().pickPdfs()
    return paths.map((p) => this.pickedPdf(p))
  }

  async pickPdfFolder(): Promise<PickedPdf[]> {
    const paths = await bridge().pickPdfFolder()
    return paths.map((p) => this.pickedPdf(p))
  }

  private pickedPdf(path: string): PickedPdf {
    return {
      name: baseName(path),
      path,
      read: async () => {
        const bytes = await bridge().readPdf(path)
        // Copy into a standalone ArrayBuffer: the IPC result may be a view into
        // a larger buffer, which pdf.js would misread.
        return bytes.slice().buffer as ArrayBuffer
      },
    }
  }

  pickReferenceFile(): Promise<{ text: string; name: string } | null> {
    return bridge().pickReferenceFile()
  }

  async relativePdfPaths(pdfs: PickedPdf[], location: ProjectLocation | null): Promise<string[]> {
    // Without a project file there is nothing to be relative to; the bare names
    // still work once the JSON lands next to the PDFs.
    if (!location?.path) return pdfs.map((p) => p.name)

    const indices = pdfs.map((p, i) => (p.path ? i : -1)).filter((i) => i >= 0)
    const relatives = await bridge().relativePaths(
      location.path,
      indices.map((i) => pdfs[i].path!),
    )
    // The caller zips the result with `pdfs` index-by-index, so keep the length.
    const out = pdfs.map((p) => p.name)
    indices.forEach((pdfIndex, n) => {
      out[pdfIndex] = relatives[n] ?? pdfs[pdfIndex].name
    })
    return out
  }

  async absolutePdfPaths(pdfPaths: string[], from: SaveHandle): Promise<(string | undefined)[]> {
    if (!from.path || pdfPaths.length === 0) return pdfPaths.map(() => undefined)
    return bridge().absolutePaths(from.path, pdfPaths)
  }

  async siblingProjectLocation(source: SaveHandle, fileName: string): Promise<ProjectLocation | null> {
    if (!source.path) return null
    const path = await bridge().siblingPath(source.path, fileName)
    return { handle: { kind: 'electron', path }, name: baseName(path), path }
  }

  // ---- AI-assisted annotation ----
  // Everything here is a pass-through to the main process, which owns the API
  // keys and makes the actual call. See electron/main.ts for why.

  listLlmConfigs(): Promise<LlmConfig[]> {
    return bridge().llmConfigs()
  }

  saveLlmConfig(config: LlmConfig, apiKey?: string): Promise<LlmConfig[]> {
    const { hasKey: _hasKey, ...rest } = config
    return bridge().saveLlmConfig(rest, apiKey)
  }

  deleteLlmConfig(id: string): Promise<LlmConfig[]> {
    return bridge().deleteLlmConfig(id)
  }

  async callLlm(request: LlmHttpRequest, signal?: AbortSignal): Promise<LlmHttpResponse> {
    // An AbortSignal cannot cross IPC, so the call is given an id and Cancel
    // sends a separate abort message that main matches against it.
    const requestId = crypto.randomUUID()
    const onAbort = () => bridge().abortLlm(requestId)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await bridge().callLlm(requestId, request)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  // Git: thin pass-throughs, except `status`, where raw porcelain/diff text crosses IPC so the
  // tested parsers (`src/git/output.ts`) handle it here. A field, not a fresh object per call,
  // so `useGitStore` selectors don't see a "different" platform and churn.
  private readonly git: GitPlatform = {
    probe: () => bridge().gitProbe(),
    pickCloneDir: () => bridge().gitPickCloneDir(),
    clone: (url, dest) => bridge().gitClone(url, dest),
    pickProjectIn: (dir) => bridge().gitPickProjectIn(dir),
    info: (projectPath) => bridge().gitInfo(projectPath),
    status: async (root): Promise<GitStatus> => {
      const { porcelain, diff } = await bridge().gitStatus(root)
      const capped = capDiff(diff)
      return { changes: parsePorcelain(porcelain), diff: capped.text, diffTruncated: capped.truncated }
    },
    commit: (root, paths, message, amend) => bridge().gitCommit(root, paths, message, amend),
    lastCommitMessage: (root) => bridge().gitLastCommitMessage(root),
    push: (root) => bridge().gitPush(root),
    // Every call below this comment can rewrite the working tree — a merge
    // that stops mid-way still wrote files, an abort restores them, a stash
    // takes them away. See `withBaselineDropped`.
    beginPull: (root, relPath) => withBaselineDropped(() => bridge().gitPullBegin(root, relPath)),
    finishPull: (root, relPath, working) => withBaselineDropped(() => bridge().gitPullFinish(root, relPath, working)),
    abortPull: (root) => withBaselineDropped(() => bridge().gitPullAbort(root)),
    beginMerge: (root, relPath, ref) => withBaselineDropped(() => bridge().gitMergeBegin(root, relPath, ref)),
    logBegin: (root, relPath) => bridge().gitLogBegin(root, relPath),
    logDiff: (root, relPath, rev) => bridge().gitLogDiff(root, relPath, rev),
    headContent: (root, relPath) => bridge().gitHeadContent(root, relPath),
    workingContent: (root, relPath) => bridge().gitWorkingContent(root, relPath),
    commitPartial: (root, relPath, committed, working, otherPaths, message, amend) =>
      withBaselineDropped(() => bridge().gitCommitPartial(root, relPath, committed, working, otherPaths, message, amend)),
    writeWorking: (root, relPath, working) => withBaselineDropped(() => bridge().gitWriteWorking(root, relPath, working)),
    discardFile: (root, relPath, projectRelPath) =>
      withBaselineDropped(() => bridge().gitDiscardFile(root, relPath, projectRelPath)),
    annotationAuthors: (root, relPath) => bridge().gitAnnotationAuthors(root, relPath),
    repoSetupStatus: (root, relPath) => bridge().gitRepoSetupStatus(root, relPath),
    applyRepoSetup: (root, relPath) => withBaselineDropped(() => bridge().gitApplyRepoSetup(root, relPath)),
    // Rewrites remote-tracking refs only, never the working tree, so the save
    // baseline stays valid.
    backgroundFetch: (root) => bridge().gitBackgroundFetch(root),
    stashList: (root) => bridge().gitStashList(root),
    // Push, restore and branch all rewrite the working tree; dropping only
    // forgets a stash and leaves the tree alone.
    stashPush: (root, relPath, message) => withBaselineDropped(() => bridge().gitStashPush(root, relPath, message)),
    stashRestore: (root, relPath, sha) => withBaselineDropped(() => bridge().gitStashRestore(root, relPath, sha)),
    stashDrop: (root, sha) => bridge().gitStashDrop(root, sha),
    stashBranch: (root, relPath, sha, branch) =>
      withBaselineDropped(() => bridge().gitStashBranch(root, relPath, sha, branch)),
    branches: (root) => bridge().gitBranches(root),
    createBranch: (root, name) => bridge().gitBranchCreate(root, name),
    deleteBranch: (root, branch) => bridge().gitBranchDelete(root, branch),
    checkoutBranch: (root, branch) => withBaselineDropped(() => bridge().gitCheckout(root, branch)),
    beginBranchSwitch: (root, relPath, branch) =>
      withBaselineDropped(() => bridge().gitBranchSwitchBegin(root, relPath, branch)),
    finishBranchSwitch: (root, relPath, resolved) =>
      withBaselineDropped(() => bridge().gitBranchSwitchFinish(root, relPath, resolved)),
    abortBranchSwitch: (root, sourceBranch) =>
      withBaselineDropped(() => bridge().gitBranchSwitchAbort(root, sourceBranch)),
  }

  getGit(): GitPlatform {
    return this.git
  }

  // ---- PDF annotation export ----
  // Thin pass-throughs; the main process owns pdf-lib and the filesystem.

  embedPdfAnnotations(
    pdfAbsPath: string,
    marks: PdfMark[],
    target: 'original' | { newPath: string },
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    return bridge().embedPdfMarks(pdfAbsPath, marks, target)
  }

  pickPdfExportPath(suggestedName: string): Promise<string | null> {
    return bridge().pickPdfExportPath(suggestedName)
  }

  // ---- Plain-text export ----

  pickTextExportPath(suggestedName: string): Promise<string | null> {
    return bridge().pickTextExportPath(suggestedName)
  }

  writeTextFile(absPath: string, text: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    return bridge().writeTextFile(absPath, text)
  }

  // ---- Self-update ----

  checkForNativeUpdate(): Promise<{ supported: boolean }> {
    return bridge().checkForNativeUpdate()
  }

  downloadNativeUpdate(): Promise<void> {
    return bridge().downloadNativeUpdate()
  }

  installNativeUpdate(): Promise<void> {
    return bridge().installNativeUpdate()
  }

  onNativeUpdateAvailable(cb: (info: { version: string }) => void): void {
    bridge().onNativeUpdateAvailable(cb)
  }

  onNativeUpdateProgress(cb: (p: { percent: number }) => void): void {
    bridge().onNativeUpdateProgress(cb)
  }

  onNativeUpdateDownloaded(cb: () => void): void {
    bridge().onNativeUpdateDownloaded(cb)
  }

  onNativeUpdateError(cb: (message: string) => void): void {
    bridge().onNativeUpdateError(cb)
  }
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}
