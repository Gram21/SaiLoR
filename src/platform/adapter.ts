/**
 * Platform abstraction for file I/O and PDF loading, so the same React app
 * runs in Electron (native dialogs + fs) and in a plain browser (File System
 * Access API / downloads / fetch).
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
  /** Handle used by saveProject to write back to the same location. */
  handle: SaveHandle
  /** Display name / path of the opened file (for the title bar). */
  name: string
  /**
   * `annotations/<paperId>/<file>` paths that failed to parse and were loaded
   * as absent (left on disk untouched). Non-empty means data is missing, so
   * the UI can say so rather than let a reviewer assume an empty seat is empty.
   */
  corruptFiles?: string[]
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
   * OS/arch we're running on, so the update notice can offer the matching
   * installer. Null in the browser (a web deployment updates by redeploying).
   */
  getOsInfo(): OsInfo | null

  /** Recently opened projects (newest first), for the Open menu. */
  getRecents(): RecentEntry[]

  /**
   * Record the project now open as a recent, with its path and title. Called
   * once the JSON is parsed, since only then is the title known.
   */
  rememberProject(handle: SaveHandle, name: string, title?: string): void

  /** Drop an entry from the recents list (the user dismissed it). */
  forgetRecent(id: string): RecentEntry[]

  /**
   * Re-check which recents are still reachable. A missing file is kept (the
   * drive may come back) but shown greyed out and can't be opened.
   */
  checkRecents(entries: RecentEntry[]): Promise<RecentEntry[]>

  /** Reopen a recent project by its opaque id. Returns null if it can't be opened. */
  openRecent(id: string): Promise<OpenedProject | null>

  /** Show an open dialog / picker and return the chosen project's text + a save handle. */
  openProject(): Promise<OpenedProject | null>

  /** Write text back to the handle's location. Returns the (possibly updated) handle.
   *  Throws `StaleSaveError`, writing nothing, when a file it would overwrite
   *  changed on disk since the project was last read or written. */
  saveProject(text: string, handle: SaveHandle): Promise<SaveHandle>

  /**
   * Re-express `pdfPaths` (relative to `from`'s directory) as paths relative
   * to `to`'s directory — needed because "Save as" moves the project file
   * while each paper's `pdf` stays relative to it. Electron resolves against
   * the real filesystem; the browser has no paths and returns the input unchanged.
   */
  rebasePdfPaths(pdfPaths: string[], from: SaveHandle, to: SaveHandle): Promise<string[]>

  /** Resolve a paper's `pdf` path (relative to the project file) into a URL react-pdf can load. */
  getPdfSource(pdfPath: string, projectHandle: SaveHandle): Promise<PdfSource>

  /**
   * True when `getPdfSource` would need to prompt for a local folder first and
   * hasn't been granted one this session. Lets a caller trigger that prompt
   * from a visible button instead of `getPdfSource` popping it unannounced.
   * Always `false` on Electron and for server-mode browser projects.
   */
  needsPdfFolderGrant(): boolean

  /**
   * Prompts for that folder now. Must be called from a real user gesture (some
   * browsers refuse the native picker otherwise). No-op if grant not needed.
   */
  grantPdfFolderAccess(): Promise<void>

  // ---- Project editor (create / edit a project JSON) ----

  /**
   * Ask the user where the project JSON should live. Writes nothing — saved
   * later via `saveProject(text, location.handle)`. Null if cancelled.
   */
  pickProjectLocation(suggestedName: string): Promise<ProjectLocation | null>

  /**
   * Would writing to `destPath` start sharing an `annotations/` folder with a
   * *different* project already there? Null if no collision (or not
   * implemented on this platform). Checked between `pickProjectLocation` and
   * the write in `saveAs()`, the only moment a new sharing relationship forms.
   */
  checkSiblingCollision(
    destPath: string,
    paperIds: string[],
    screening: boolean,
  ): Promise<{ siblingName: string; overlappingIds: string[] } | null>

  /** Pick one or more PDFs to reference. Returns [] if cancelled. */
  pickPdfs(): Promise<PickedPdf[]>

  /** Pick a folder; returns every PDF inside it (recursively). [] if cancelled. */
  pickPdfFolder(): Promise<PickedPdf[]>

  /** Pick a .bib/.ris/.json reference file. Null if cancelled. */
  pickReferenceFile(): Promise<{ text: string; name: string } | null>

  /**
   * The `pdf` values to store for these PDFs, relative to the project JSON's
   * directory. Electron computes real relative paths; the browser has no
   * paths and returns the bare file names.
   */
  relativePdfPaths(pdfs: PickedPdf[], location: ProjectLocation | null): Promise<string[]>

  /**
   * Absolute paths for `pdfPaths` (relative to `from`'s directory) — the
   * inverse of `relativePdfPaths`, needed when a paper imported from a
   * screening project must re-derive its `pdf` if the new JSON moves.
   * Electron resolves against the real filesystem; the browser returns
   * `undefined` per entry, which `changeLocation` skips.
   */
  absolutePdfPaths(pdfPaths: string[], from: SaveHandle): Promise<(string | undefined)[]>

  /**
   * Where a new project JSON should go if placed next to `source`: same
   * directory, named `fileName`. Writes/prompts nothing.
   *
   * Makes "save the annotation JSON next to the screening JSON" the default,
   * so every paper's relative `pdf` keeps resolving without rewriting.
   * Null in the browser (no paths); callers fall back to `pickProjectLocation`.
   */
  siblingProjectLocation(source: SaveHandle, fileName: string): Promise<ProjectLocation | null>

  // ---- AI-assisted annotation ----

  /**
   * The configured LLM targets. **Never carries the API key** — see `LlmConfig`.
   * In Electron the keys live in the main process; the renderer only learns
   * whether one is set (`hasKey`).
   */
  listLlmConfigs(): Promise<LlmConfig[]>

  /**
   * Create or update a target. `apiKey` is written only when provided (so
   * leaving the field untouched keeps the stored key) and is never read back.
   */
  saveLlmConfig(config: LlmConfig, apiKey?: string): Promise<LlmConfig[]>

  deleteLlmConfig(id: string): Promise<LlmConfig[]>

  /**
   * Send a request built by `src/llm/providers.ts`. Its headers carry
   * `API_KEY_SENTINEL`, not the key — the platform substitutes the real key
   * at the last moment.
   *
   * Electron sends this from the main process via `net.fetch`, which has no
   * document origin and so isn't subject to CORS (a renderer fetch would be
   * preflighted and blocked). The browser build just calls `fetch` directly,
   * which some providers will refuse.
   */
  callLlm(request: LlmHttpRequest, signal?: AbortSignal): Promise<LlmHttpResponse>

  /**
   * Git operations against **the user's own git installation**, or `null`
   * where the runtime can't reach one.
   *
   * Only Electron can: its main process spawns the real `git` binary, so
   * ~/.gitconfig, credential helpers and SSH agent all apply. A browser page
   * can't spawn a process or reach any of that, and a pure-JS reimplementation
   * would be a different thing wearing the same name — so it returns `null`
   * and the UI hides git rather than pretending.
   *
   * This is about the *runtime*; whether the machine has git installed is
   * answered separately by `GitPlatform.probe()`.
   */
  getGit(): GitPlatform | null

  // ---- PDF annotation export ----
  // One-way, user-triggered export of reviewer/consolidation marks into real
  // PDF annotation objects — see src/model/pdfMarks.ts and
  // src/model/pdfExport.ts for why this is separate from the in-app overlay.

  /**
   * Burn `marks` into `pdfAbsPath` as Highlight/Text annotations, writing back
   * to the same file (`'original'`) or to `target.newPath`. Never throws —
   * failures come back as `{ ok: false, error }` for the export dialog.
   */
  embedPdfAnnotations(
    pdfAbsPath: string,
    marks: PdfMark[],
    target: 'original' | { newPath: string },
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }>

  /** Ask where a new annotated PDF should be saved. Null if cancelled. */
  pickPdfExportPath(suggestedName: string): Promise<string | null>

  // ---- Plain-text export ----
  // Generic "save this text to a file the reviewer picks"; the disagreement
  // export (src/consolidate/exportDisagreements.ts) is the first user, but
  // nothing here is specific to it. Split into a picker and a writer so a
  // future caller that already knows the destination can skip to `writeTextFile`.

  /** Ask where a text file should be saved. Null if cancelled. */
  pickTextExportPath(suggestedName: string): Promise<string | null>

  /** Write `text` to `absPath`. Never throws — failures come back as `{ ok: false, error }`. */
  writeTextFile(absPath: string, text: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>

  // ---- Self-update ----
  // Windows/Linux only — macOS has no reliable unsigned/unnotarized
  // auto-update path (see electron/main.ts), so it stays on the check-only
  // banner. `supported: false` means don't offer the download/install UI.
  //
  // Download and install are explicit, user-triggered calls only.

  /** Ask whether a newer version can be downloaded. `supported: false` on the
   *  browser build or on macOS, where this flow is disabled. */
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

/** A save that wrote nothing because these files changed on disk since the
 *  project was last read or written. Paths are relative to the project's
 *  folder (`annotations/p1/reviewer-2.json`, or the project file's own name). */
export class StaleSaveError extends Error {
  constructor(readonly paths: string[]) {
    super(`These files changed on disk since this project was opened: ${paths.join(', ')}`)
    this.name = 'StaleSaveError'
  }
}
