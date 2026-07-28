import type {
  OpenedProject,
  OsInfo,
  PdfSource,
  PickedPdf,
  PlatformAdapter,
  ProjectLocation,
  SaveHandle,
} from './adapter'
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
  SplitProject,
  GitBranch,
  BranchSwitchStart,
} from '../git/types'
import { parsePorcelain, capDiff } from '../git/output'
import { loadProject, splitProjectFiles } from '../model/project'
import type { PdfMark } from '../model/pdfMarks'

const RECENTS_KEY = 'slr.recents.electron'

/** Shape of the API exposed by electron/preload.ts on `window.slr`. */
export interface SlrBridge {
  /** The machine this build is running on (from process.platform / process.arch). */
  os: { platform: string; arch: string }
  openProject(): Promise<{ path: string; text: string } | null>
  /** Read a specific file by absolute path (for recent files). Null if missing. */
  openPath(path: string): Promise<{ path: string; text: string } | null>
  saveProject(path: string, metaText: string, files: Array<{ relPath: string; text: string | null }>): Promise<void>
  /** Register the project's base directory so slr-file:// can resolve PDFs. */
  setProjectDir(path: string): Promise<void>
  /** Pick a location for a project JSON without writing it. Null if cancelled. */
  pickSavePath(suggestedName: string): Promise<{ path: string } | null>
  /** Pick PDFs to reference. Returns their absolute paths, [] if cancelled. */
  pickPdfs(): Promise<string[]>
  /** Pick a folder; returns the absolute paths of every PDF inside it (recursively). [] if cancelled. */
  pickPdfFolder(): Promise<string[]>
  /** Pick a .bib/.ris/.json reference file. Null if cancelled. */
  pickReferenceFile(): Promise<{ text: string; name: string } | null>
  /** Raw bytes of a PDF by absolute path (for reading its title/authors). */
  readPdf(path: string): Promise<Uint8Array>
  /** Whether `rel` (relative to the project's directory) is safe and
   *  reachable to read via slr-file:// — the same traversal/symlink guard
   *  `registerPdfProtocol` enforces when actually serving it, checked first
   *  so a blocked or missing PDF gets an honest reason instead of pdf.js's
   *  own opaque failure for an HTTP status it never explains. */
  checkPdfPath(rel: string): Promise<{ ok: true } | { ok: false; reason: 'no-project' | 'escapes' | 'not-found' }>
  /** Records that the reviewer chose to open `rel` even though it points
   *  outside the project's own folder, for the rest of this session — see
   *  `getPdfSource`'s confirm and `allowedEscapes` in electron/main.ts. */
  allowPdfPath(rel: string): Promise<void>
  /** Burn `marks` into the PDF at `pdfAbsPath` as real annotation objects. */
  embedPdfMarks(
    pdfAbsPath: string,
    marks: unknown,
    target: 'original' | { newPath: string },
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  /** Pick where a new annotated PDF should be saved. Null if cancelled. */
  pickPdfExportPath(suggestedName: string): Promise<string | null>
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
  gitCommit(root: string, paths: string[], message: string): Promise<GitRun>
  gitPush(root: string): Promise<GitRun>
  gitPullBegin(root: string, relPath: string): Promise<PullStart>
  gitPullFinish(root: string, relPath: string, working: SplitProject): Promise<GitRun>
  gitPullAbort(root: string): Promise<GitRun>
  gitHeadContent(root: string, relPath: string): Promise<string | null>
  gitWorkingContent(root: string, relPath: string): Promise<string | null>
  gitCommitPartial(
    root: string,
    relPath: string,
    committed: SplitProject,
    working: SplitProject,
    otherPaths: string[],
    message: string,
  ): Promise<GitRun>
  gitWriteWorking(root: string, relPath: string, working: SplitProject): Promise<GitRun>
  gitBranches(root: string): Promise<GitBranch[]>
  gitBranchCreate(root: string, name: string): Promise<GitRun>
  gitCheckout(root: string, branch: string): Promise<GitRun>
  gitBranchSwitchBegin(root: string, relPath: string, branch: string): Promise<BranchSwitchStart>
  gitBranchSwitchFinish(root: string, relPath: string, resolved: SplitProject): Promise<GitRun>
  gitBranchSwitchAbort(root: string, sourceBranch: string): Promise<GitRun>
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
        // Re-read from the file: the stored title goes stale the moment the
        // project is renamed elsewhere (e.g. in the project editor).
        // `undefined` means the file sets no title, so the name is used again.
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
    pushRecent(RECENTS_KEY, { id: res.path, name: baseName(res.path), path: res.path })
    return {
      text: res.text,
      handle: { kind: 'electron', path: res.path },
      name: baseName(res.path),
    }
  }

  async openRecent(id: string): Promise<OpenedProject | null> {
    const res = await bridge().openPath(id)
    // The file is gone. Keep the entry — the drive may come back — the caller
    // marks it unavailable instead of forgetting it.
    if (!res) return null
    await bridge().setProjectDir(res.path)
    pushRecent(RECENTS_KEY, { id: res.path, name: baseName(res.path), path: res.path })
    return {
      text: res.text,
      handle: { kind: 'electron', path: res.path },
      name: baseName(res.path),
    }
  }

  async saveProject(text: string, handle: SaveHandle): Promise<SaveHandle> {
    if (!handle.path) throw new Error('No file path; use "Save as".')
    // `text` is the logical whole-project JSON (`serializeProject`'s shape) —
    // the contract every platform shares, and what git-diff/tests deal in.
    // On disk this build splits it into `project.json` (meta only) plus an
    // `annotations/<paperId>/…` file per reviewer/consolidated tree; see
    // `splitProjectFiles`'s own doc comment for why.
    const { meta, files } = splitProjectFiles(loadProject(text))
    await bridge().saveProject(handle.path, JSON.stringify(meta, null, 2), files)
    return handle
  }

  async rebasePdfPaths(pdfPaths: string[], from: SaveHandle, to: SaveHandle): Promise<string[]> {
    if (!from.path || !to.path || pdfPaths.length === 0) return pdfPaths
    return bridge().rebasePaths(from.path, to.path, pdfPaths)
  }

  async getPdfSource(pdfPath: string, projectHandle: SaveHandle): Promise<PdfSource> {
    // Re-assert the base directory from the handle of the project we're actually
    // rendering. The project editor repoints it when picking a new location, so
    // trusting whatever was set last would resolve PDFs against the wrong dir.
    if (projectHandle?.path) await bridge().setProjectDir(projectHandle.path)
    // Ask before constructing the URL: the protocol handler enforces the same
    // check when actually serving the file, but a 403/404 from a custom
    // protocol reaches the reviewer as pdf.js's own generic load-failure
    // message, which says nothing about *why*. This surfaces the real reason
    // as a normal thrown Error instead — the load effect in PdfViewer.tsx
    // already renders whatever this throws.
    const check = await bridge().checkPdfPath(pdfPath)
    if (!check.ok) {
      if (check.reason === 'escapes') {
        // Not a hard refusal: the reviewer is trusted to know whether they
        // trust *this* project enough to let it read a file outside its own
        // folder — see `allowedEscapes` in electron/main.ts for the whole
        // reasoning. `window.confirm` matches how this app already asks
        // "are you sure" elsewhere (GitDialog's discard warnings, deleting
        // an annotated paper) rather than a bespoke dialog for just this.
        const ok = window.confirm(
          `PDF "${pdfPath}" is stored outside this project's own folder.\n\n` +
            `Opening it means reading a file at a path the project itself names. If you didn't author this ` +
            `project yourself — it came from a collaborator, or somewhere else — that path could point at a file ` +
            `on your disk you didn't intend to share. Only continue if you trust where this project came from.\n\n` +
            `Open it anyway?`,
        )
        if (!ok) {
          throw new Error(
            `PDF "${pdfPath}" was not opened — it points outside the project's own folder, and you chose not to open it.`,
          )
        }
        await bridge().allowPdfPath(pdfPath)
        // Falls through to the URL below: the reviewer just approved this
        // exact path, so there's nothing left to re-check before using it.
      } else if (check.reason === 'not-found') {
        throw new Error(`PDF "${pdfPath}" was not found relative to the project's own folder.`)
      } else {
        throw new Error('No project is open.')
      }
    }
    // The main process serves files from the project dir via slr-file://.
    // Carried as a query param, not the URL's path: a `..` segment sitting
    // in the *path* is a dot-segment by the URL Standard's own definition,
    // which Chromium's URL parser collapses (per spec, before this string
    // even reaches `registerPdfProtocol` — before `net.fetch`/`getDocument`
    // ever issues the request) the exact same way it would for a normal
    // http(s) link, silently eating every ".." a `pdf` value climbed with
    // and requesting something else entirely. A query value is never
    // subject to that normalization, at any parsing layer, so it round-trips
    // exactly as written.
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
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const onAbort = () => bridge().abortLlm(requestId)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await bridge().callLlm(requestId, request)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  // Git: thin pass-throughs to the bridge, except `status`, where the raw
  // porcelain/diff text crosses IPC on purpose so the tested parsers
  // (`src/git/output.ts`) turn it into data on this side.
  //
  // A `private readonly` field, not a fresh object literal per call: getPlatform()
  // is a singleton, and a new object every time `getGit()` is called would make
  // every `useGitStore` selector see a "different" platform and churn.
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
    commit: (root, paths, message) => bridge().gitCommit(root, paths, message),
    push: (root) => bridge().gitPush(root),
    beginPull: (root, relPath) => bridge().gitPullBegin(root, relPath),
    finishPull: (root, relPath, working) => bridge().gitPullFinish(root, relPath, working),
    abortPull: (root) => bridge().gitPullAbort(root),
    headContent: (root, relPath) => bridge().gitHeadContent(root, relPath),
    workingContent: (root, relPath) => bridge().gitWorkingContent(root, relPath),
    commitPartial: (root, relPath, committed, working, otherPaths, message) =>
      bridge().gitCommitPartial(root, relPath, committed, working, otherPaths, message),
    writeWorking: (root, relPath, working) => bridge().gitWriteWorking(root, relPath, working),
    branches: (root) => bridge().gitBranches(root),
    createBranch: (root, name) => bridge().gitBranchCreate(root, name),
    checkoutBranch: (root, branch) => bridge().gitCheckout(root, branch),
    beginBranchSwitch: (root, relPath, branch) => bridge().gitBranchSwitchBegin(root, relPath, branch),
    finishBranchSwitch: (root, relPath, resolved) => bridge().gitBranchSwitchFinish(root, relPath, resolved),
    abortBranchSwitch: (root, sourceBranch) => bridge().gitBranchSwitchAbort(root, sourceBranch),
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
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}
