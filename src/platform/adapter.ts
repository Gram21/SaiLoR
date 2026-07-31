/**
 * Platform abstraction for file I/O and PDF loading. The React app talks only
 * to this interface, so the same code runs inside Electron (native dialogs +
 * fs) and in a plain browser (File System Access API / downloads / fetch).
 */

import type { RecentEntry } from './recents'
import type { OsInfo } from '../model/version'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse } from '../llm/types'
import type { GitPlatform } from '../git/types'
import type { PdfMark } from '../model/pdfMarks'

export type { RecentEntry }
export type { OsInfo }

export interface OpenedProject {
  /** Raw JSON text of the project file. */
  text: string
  /** A handle used by saveProject to write back to the same location. */
  handle: SaveHandle
  /** Display name / path of the opened file (for the title bar). */
  name: string
}

export interface SaveHandle {
  kind: 'electron' | 'fsapi' | 'download'
  /** Electron: absolute path. FSAPI: the id of the retained file handle. */
  path?: string
  /** File name, so the download fallback can name what it writes. */
  name?: string
}

export interface PdfSource {
  /** A URL usable directly as a react-pdf `file` prop (blob:, slr-file://, http(s), or relative). */
  url: string
  /** Optional cleanup for object URLs. */
  revoke?: () => void
}

/** Where a project JSON lives (or will be written). Used by the project editor. */
export interface ProjectLocation {
  handle: SaveHandle
  /** File name, e.g. "review.json". */
  name: string
  /** Absolute path — Electron only. The browser's File System Access API exposes no paths. */
  path?: string
}

/** A PDF the user picked to reference from a project. */
export interface PickedPdf {
  /** File name, e.g. "paper.pdf". */
  name: string
  /** Absolute path — Electron only. */
  path?: string
  /** Read the file's bytes, so the editor can pull out the title/authors. */
  read?: () => Promise<ArrayBuffer>
}

export interface PlatformAdapter {
  readonly kind: 'electron' | 'browser'

  /**
   * The OS/arch we're running on, so the update notice can offer the installer
   * that matches this machine. Null in the browser, which has no installer to
   * offer (a web deployment updates by redeploying).
   */
  getOsInfo(): OsInfo | null

  /** Recently opened projects (newest first), for the Open menu. */
  getRecents(): RecentEntry[]

  /**
   * Record the project now open as a recent, together with its path and its own
   * title. Called once the JSON is parsed, since only then is the title known.
   */
  rememberProject(handle: SaveHandle, name: string, title?: string): void

  /** Drop an entry from the recents list (the user dismissed it). */
  forgetRecent(id: string): RecentEntry[]

  /**
   * Re-check which recents are still reachable, returning them with `available`
   * set. A missing file is kept (the drive may come back) but is shown greyed
   * out and can't be opened.
   */
  checkRecents(entries: RecentEntry[]): Promise<RecentEntry[]>

  /** Reopen a recent project by its opaque id. Returns null if it can't be opened. */
  openRecent(id: string): Promise<OpenedProject | null>

  /** Show an open dialog / picker and return the chosen project's text + a save handle. */
  openProject(): Promise<OpenedProject | null>

  /** Write text back to the handle's location. Returns the (possibly updated) handle. */
  saveProject(text: string, handle: SaveHandle): Promise<SaveHandle>

  /**
   * Re-express `pdfPaths` — which are relative to `from`'s directory — as paths
   * relative to `to`'s directory. "Save as" moves the project file, and a
   * paper's `pdf` is stored relative to it, so without this every PDF would
   * fail to resolve at the new location.
   *
   * Electron resolves this against the real filesystem. The browser has no
   * paths, so it returns the input unchanged.
   */
  rebasePdfPaths(pdfPaths: string[], from: SaveHandle, to: SaveHandle): Promise<string[]>

  /**
   * Resolve a paper's `pdf` path (relative to the project file) into a URL that
   * react-pdf can load.
   */
  getPdfSource(pdfPath: string, projectHandle: SaveHandle): Promise<PdfSource>

  /**
   * True when `getPdfSource` would need to prompt for a local folder before
   * it can resolve anything, and hasn't been granted one yet this session —
   * i.e. a locally opened browser project whose PDFs have never been
   * located. Always `false` on Electron (no such prompt exists) and for a
   * server-mode browser project (PDFs are fetched, nothing to grant).
   *
   * Exists so a caller can ask for that grant explicitly — from a visible
   * button the reviewer clicks — rather than have `getPdfSource` pop a
   * native folder picker unannounced the first time a PDF is opened, which
   * reads as the app doing something on its own for no visible reason.
   */
  needsPdfFolderGrant(): boolean

  /**
   * Prompts for that folder now. Must be called from a real user gesture (a
   * native picker will not open otherwise — some browsers enforce this
   * strictly). A no-op wherever `needsPdfFolderGrant()` is `false`.
   */
  grantPdfFolderAccess(): Promise<void>

  // ---- Project editor (create / edit a project JSON) ----

  /**
   * Ask the user where the project JSON should live. Writes nothing — the
   * editor saves through `saveProject(text, location.handle)` later.
   * Returns null if the user cancels.
   */
  pickProjectLocation(suggestedName: string): Promise<ProjectLocation | null>

  /** Pick one or more PDFs to reference. Returns [] if cancelled. */
  pickPdfs(): Promise<PickedPdf[]>

  /** Pick a folder; returns every PDF inside it (recursively). [] if cancelled. */
  pickPdfFolder(): Promise<PickedPdf[]>

  /** Pick a .bib/.ris/.json reference file. Null if cancelled. */
  pickReferenceFile(): Promise<{ text: string; name: string } | null>

  /**
   * The `pdf` values to store for these PDFs, relative to the project JSON's
   * directory. Electron computes real relative paths (POSIX separators), so
   * moving the JSON re-derives them. The browser has no paths, so it returns
   * the bare file names.
   */
  relativePdfPaths(pdfs: PickedPdf[], location: ProjectLocation | null): Promise<string[]>

  /**
   * Absolute paths for `pdfPaths`, which are relative to `from`'s directory.
   * The inverse of `relativePdfPaths`, and it exists for the same reason: a
   * paper imported from a screening project carries a `pdf` relative to *that*
   * file, so without an absolute source the editor cannot re-derive it if the
   * new JSON is moved — every PDF would silently point at nothing (the bug
   * `rebasePdfPaths` already exists to prevent for "Save as").
   *
   * Electron resolves against the real filesystem. The browser has no paths
   * and returns `undefined` per entry, which leaves those rows exactly where
   * an edited project's rows already are: `changeLocation` skips them.
   */
  absolutePdfPaths(pdfPaths: string[], from: SaveHandle): Promise<(string | undefined)[]>

  /**
   * Where a new project JSON should go if it sits next to `source`: the same
   * directory, named `fileName`. Writes nothing, prompts nothing.
   *
   * This is what makes "the new annotation JSON is saved next to the
   * screening JSON" the *default* rather than a suggestion in a dialog — and
   * it is not cosmetic: a sibling shares the screening file's directory, so
   * every paper's relative `pdf` still resolves without being rewritten at
   * all.
   *
   * Null in the browser, which has no paths to build one from; callers fall
   * back to `pickProjectLocation`.
   */
  siblingProjectLocation(source: SaveHandle, fileName: string): Promise<ProjectLocation | null>

  // ---- AI-assisted annotation ----

  /**
   * The configured LLM targets. **Never carries the API key** — see `LlmConfig`.
   * In Electron the keys live in the main process; the renderer only learns
   * whether a key is set (`hasKey`).
   */
  listLlmConfigs(): Promise<LlmConfig[]>

  /**
   * Create or update a target. `apiKey` is written only when provided (so an
   * edit that leaves the key field untouched keeps the stored key), and is never
   * read back.
   */
  saveLlmConfig(config: LlmConfig, apiKey?: string): Promise<LlmConfig[]>

  deleteLlmConfig(id: string): Promise<LlmConfig[]>

  /**
   * Send a request built by `src/llm/providers.ts`. Its headers carry
   * `API_KEY_SENTINEL`, not the key: the platform substitutes the real key at the
   * last moment.
   *
   * In Electron this crosses to the main process and is sent with `net.fetch`,
   * which has no document origin and so is not subject to CORS. A renderer fetch
   * would be preflighted and blocked (the packaged renderer's origin is
   * `file://`). The browser build has no such escape hatch and calls `fetch`
   * directly, which some providers will refuse.
   */
  callLlm(request: LlmHttpRequest, signal?: AbortSignal): Promise<LlmHttpResponse>

  /**
   * Git operations against **the user's own git installation**, or `null`
   * where the runtime cannot reach one.
   *
   * Only the Electron build can: the main process spawns the real `git`
   * binary, so the user's ~/.gitconfig, credential helpers and SSH agent all
   * apply. A browser page cannot spawn a process, cannot read a config file,
   * and cannot reach an agent — and there is no honest fallback, because "the
   * local git configuration" is exactly what a sandboxed page has no access
   * to. A pure-JS reimplementation (e.g. isomorphic-git) would be a different
   * thing wearing the same name, so the browser returns `null` and the UI
   * hides git rather than pretending.
   *
   * Null is about the *runtime*. Whether this *machine* has git installed is
   * a separate question, asked by `GitPlatform.probe()`.
   */
  getGit(): GitPlatform | null

  // ---- PDF annotation export ----
  // A one-way, user-triggered export of the reviewer's/consolidation's marks
  // into real PDF annotation objects — see src/model/pdfMarks.ts and
  // src/model/pdfExport.ts for why this is deliberately separate from the
  // in-app overlay.

  /**
   * Burn `marks` into `pdfAbsPath` as Highlight/Text annotations, writing
   * either back to the same file (`'original'`) or to `target.newPath`.
   * Never throws — a failure (encrypted/corrupt PDF, write error) comes back
   * as `{ ok: false, error }` so the export dialog can show it inline.
   */
  embedPdfAnnotations(
    pdfAbsPath: string,
    marks: PdfMark[],
    target: 'original' | { newPath: string },
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }>

  /** Ask where a new annotated PDF should be saved. Null if cancelled. */
  pickPdfExportPath(suggestedName: string): Promise<string | null>

  // ---- Plain-text export ----
  // A generic "save this text to a file the reviewer picks" — the disagreement
  // export (src/consolidate/exportDisagreements.ts) is the first user, but
  // nothing here is specific to it. Split into a picker and a writer, the same
  // shape as the PDF export above, rather than one combined call, so a future
  // caller that already knows the destination (e.g. always overwriting a
  // fixed report file) can skip straight to `writeTextFile`.

  /** Ask where a text file should be saved. Null if cancelled. */
  pickTextExportPath(suggestedName: string): Promise<string | null>

  /** Write `text` to `absPath`. Never throws — a failure (permissions, a
   *  symlinked destination) comes back as `{ ok: false, error }`. */
  writeTextFile(absPath: string, text: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>

  // ---- Self-update ----
  // Windows/Linux only — macOS has no reliable unsigned/unnotarized auto-update
  // path (see electron/main.ts), so it stays on the check-only banner that
  // `getOsInfo`/`fetchLatestRelease` already drive. `supported: false` (the
  // browser build, or Electron-on-mac) means the caller should not offer the
  // download/install UI at all.
  //
  // Download and install are both explicit, user-triggered calls — nothing
  // here runs on a timer or as a side effect of `checkForNativeUpdate`.

  /** Ask whether a newer version can be downloaded. `supported: false` on the
   *  browser build or on macOS, where this whole flow is disabled. */
  checkForNativeUpdate(): Promise<{ supported: boolean }>

  /** Start downloading the update found by `checkForNativeUpdate`. Progress
   *  and completion arrive via the `onNativeUpdate*` callbacks below. */
  downloadNativeUpdate(): Promise<void>

  /** Quit and install the update already downloaded. */
  installNativeUpdate(): Promise<void>

  onNativeUpdateAvailable(cb: (info: { version: string }) => void): void
  onNativeUpdateProgress(cb: (p: { percent: number }) => void): void
  onNativeUpdateDownloaded(cb: () => void): void
  onNativeUpdateError(cb: (message: string) => void): void
}

/** True when running inside the Electron shell (preload exposed `window.slr`). */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { slr?: unknown }).slr)
}
