import type {
  OpenedProject,
  OsInfo,
  PdfFolderScan,
  PdfSource,
  PickedPdf,
  PlatformAdapter,
  ProjectLocation,
  SaveHandle,
} from './adapter'
import { StaleSaveError, type SharedAnnotations } from './adapter'
import { readRecents, pushRecent, removeRecent, replaceRecents, type RecentEntry } from './recents'
import { getBridge, type OpenedHead } from './bridge'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse, WebFetchResult } from '../llm/types'
import type { LocalServerResult, OllamaApi } from './ollamaApi'
import type { LocalRuntimeApi } from './localRuntime'
import type { GitPlatform, GitStatus } from '../git/types'
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

// [impl->req~plt-41~1]
function noteWritten(path: string, meta: string, files: ProjectFileEntry[]): void {
  lastWritten = { path, meta, files: new Map(files.map((f) => [f.relPath, f.text])) }
}

// [impl->req~plt-41~1]
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

// [impl->req~plt-43~1]
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

// [impl->req~plt-41~1]
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

// [impl->req~plt-442~1]
/** The project whose papers are still being read, and which are left: saving it would drop them. */
let streaming: { path: string; left: Set<string> } | null = null

const bridge = getBridge

/** Desktop adapter: native dialogs + fs via the bridge, PDFs via the slr-file:// protocol. */
export class DesktopAdapter implements PlatformAdapter {
  readonly kind = 'tauri' as const

  getOsInfo(): OsInfo | null {
    return bridge().os ?? null
  }

  setWindowTitle(title: string): void {
    bridge().setWindowTitle(title)
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

  // [impl->req~plt-150~1]
  async checkRecents(entries: RecentEntry[]): Promise<RecentEntry[]> {
    if (entries.length === 0) return entries
    // The id IS the absolute path on the desktop.
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

  async openProject(streamed = false): Promise<OpenedProject | null> {
    return this.opened(await bridge().openProject(), streamed)
  }

  async openRecent(id: string, streamed = false): Promise<OpenedProject | null> {
    // Keep the entry even if the file is gone — the drive may come back — caller marks it unavailable instead.
    return this.opened(await bridge().openPath(id), streamed)
  }

  // [impl->req~plt-440~1]
  // [impl->req~plt-442~1]
  /** Unless `streamed`, reads every paper before returning the whole project. */
  private async opened(res: OpenedHead | null, streamed: boolean): Promise<OpenedProject | null> {
    if (!res) return null
    await bridge().setProjectDir(res.path)
    pushRecent(RECENTS_KEY, { id: res.path, name: baseName(res.path), path: res.path })
    const at = { handle: { kind: 'electron' as const, path: res.path }, name: baseName(res.path) }
    streaming = null
    if (!res.readPapers || !streamed) {
      const all = res.readPapers ? await res.readPapers() : { text: res.text, corrupt: [] }
      noteOpened(res.path, all.text)
      return { ...at, text: all.text, corruptFiles: [...res.corrupt, ...all.corrupt] }
    }
    const left = new Set<string>()
    try {
      const head = loadProject(res.text)
      for (const p of head.papers) left.add(p.id)
      noteWritten(res.path, JSON.stringify(splitProjectFiles(head).meta, null, 2), [])
    } catch {
      lastWritten = null
    }
    const mine = left.size > 0 ? (streaming = { path: res.path, left }) : null
    const base = lastWritten
    const read = res.readPapers
    const readPapers = async (ids: string[]) => {
      const batch = await read(ids)
      const project = loadProject(batch.text)
      try {
        if (base && lastWritten === base)
          for (const f of splitProjectFiles(project).files) base.files.set(f.relPath, f.text)
      } catch {
        lastWritten = null
      }
      if (mine && streaming === mine) {
        for (const id of ids) mine.left.delete(id)
        if (mine.left.size === 0) streaming = null
      }
      return { papers: project.papers, corruptFiles: batch.corrupt }
    }
    return { ...at, text: res.text, corruptFiles: res.corrupt, readPapers }
  }

  // [impl->req~plt-41~1]
  // [impl->req~plt-42~1]
  // [impl->req~plt-135~1]
  async saveProject(text: string, handle: SaveHandle): Promise<SaveHandle> {
    if (!handle.path) throw new Error('No file path; use "Save as".')
    if (streaming?.path === handle.path) throw new Error('The project is still loading; save once every paper has loaded.')
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
    const before = lastWritten
    const { stale } = await bridge().saveProject(handle.path, base?.meta === metaText ? null : metaText, [...changed, ...removed])
    if (stale.length > 0) throw new StaleSaveError(stale)
    // [impl->req~plt-457~1]
    // An open during the write set the baseline of the project now open; keep it.
    if (lastWritten === before) noteWritten(handle.path, metaText, files)
    return handle
  }

  // [impl->req~plt-80~1]
  async rebasePdfPaths(pdfPaths: string[], from: SaveHandle, to: SaveHandle): Promise<string[]> {
    if (!from.path || !to.path || pdfPaths.length === 0) return pdfPaths
    return bridge().rebasePaths(from.path, to.path, pdfPaths)
  }

  // [impl->req~plt-210~1]
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
        // folder (see src-tauri/src/authz.rs). The confirm dialog runs in the Rust
        // shell so a renderer can't just approve its own escape.
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
    // WebView2 on Windows serves custom schemes as http://<scheme>.localhost.
    const base = navigator.userAgent.includes('Windows') ? 'http://slr-file.localhost' : 'slr-file://project'
    return { url: `${base}/pdf?path=${encodeURIComponent(pdfPath)}` }
  }

  // [impl->req~plt-420~1]
  async scanPdfFolder(folder: string, known: string[], projectHandle: SaveHandle): Promise<PdfFolderScan> {
    if (projectHandle?.path) await bridge().setProjectDir(projectHandle.path)
    const r = await bridge().scanPdfFolder(folder, known)
    if ('error' in r) throw new Error(r.error)
    return r
  }

  // The desktop app reads PDFs straight off disk via slr-file:// — there is no
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

  annotationsDirUsers(projectPath: string, folder: string, paperIds: string[], screening: boolean): Promise<string[]> {
    return bridge().annotationsDirUsers(projectPath, folder, paperIds, screening)
  }

  sharedAnnotations(projectPath: string): Promise<SharedAnnotations | null> {
    return bridge().sharedAnnotations(projectPath)
  }

  moveAnnotationsDir(projectPath: string, folder: string): Promise<void> {
    return bridge().moveAnnotationsDir(projectPath, folder)
  }

  async writeFeedback(handle: SaveHandle, fileName: string, content: string): Promise<string | null> {
    return handle.kind === 'electron' && handle.path ? bridge().writeFeedback(handle.path, fileName, content) : null
  }

  async listFeedback(handle: SaveHandle): Promise<{ name: string; bytes: number }[]> {
    return handle.kind === 'electron' && handle.path ? bridge().listFeedback(handle.path) : []
  }

  screeningSource(projectPath: string): Promise<{ name: string; text: string } | null> {
    return bridge().screeningSource(projectPath)
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
  // Everything here is a pass-through to the Rust shell, which owns the API
  // keys and makes the actual call. See src-tauri/src/llm.rs for why.

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

  get localRuntime(): LocalRuntimeApi {
    return bridge().local
  }

  readonly ollama: OllamaApi = {
    version: (baseUrl) => bridge().ollama.version(baseUrl),
    list: (baseUrl) => bridge().ollama.list(baseUrl),
    show: (baseUrl, model, numCtx) => bridge().ollama.show(baseUrl, model, numCtx),
    ps: (baseUrl) => bridge().ollama.ps(baseUrl),
    delete: (baseUrl, model) => bridge().ollama.delete(baseUrl, model),
    manifestSize: (model) => bridge().ollama.manifestSize(model),
    async pull(baseUrl, model, onProgress, signal) {
      const requestId = crypto.randomUUID()
      const off = bridge().ollama.onPullProgress((p) => {
        if (p.requestId === requestId) onProgress(p)
      })
      const onAbort = () => bridge().ollama.cancelPull(requestId)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        return await bridge().ollama.pull(requestId, baseUrl, model)
      } finally {
        off()
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }

  discoverLocalServer(baseUrl: string): Promise<LocalServerResult> {
    return bridge().discoverLocalServer(baseUrl)
  }

  async fetchWeb(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
    const requestId = crypto.randomUUID()
    const onAbort = () => bridge().abortWeb(requestId)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await bridge().fetchWeb(requestId, url)
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
    undoMerge: (root, relPath) => withBaselineDropped(() => bridge().gitUndoMerge(root, relPath)),
    previewMerge: (root, relPath, ref) => bridge().gitMergePreview(root, relPath, ref),
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

  pickTextExportPath(suggestedName: string, extension?: string): Promise<string | null> {
    return bridge().pickTextExportPath(suggestedName, extension)
  }

  writeTextFile(absPath: string, text: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    return bridge().writeTextFile(absPath, text)
  }

  writeBinaryFile(absPath: string, bytes: Uint8Array): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    return bridge().writeBinaryFile(absPath, Array.from(bytes))
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
