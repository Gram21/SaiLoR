/**
 * Platform abstraction for file I/O and PDF loading. The React app talks only
 * to this interface, so the same code runs inside Electron (native dialogs +
 * fs) and in a plain browser (File System Access API / downloads / fetch).
 */

import type { RecentEntry } from './recents'

export type { RecentEntry }

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
  /** Electron: absolute path. FSAPI: undefined (uses the retained file handle). */
  path?: string
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

  /** Recently opened projects (newest first), for the Open menu. */
  getRecents(): RecentEntry[]

  /** Reopen a recent project by its opaque id. Returns null if it can't be opened. */
  openRecent(id: string): Promise<OpenedProject | null>

  /** Show an open dialog / picker and return the chosen project's text + a save handle. */
  openProject(): Promise<OpenedProject | null>

  /** Write text back to the handle's location. Returns the (possibly updated) handle. */
  saveProject(text: string, handle: SaveHandle): Promise<SaveHandle>

  /** Prompt for a new location and write there. Returns the new handle + name. */
  saveProjectAs(text: string, suggestedName: string): Promise<{ handle: SaveHandle; name: string } | null>

  /**
   * Resolve a paper's `pdf` path (relative to the project file) into a URL that
   * react-pdf can load.
   */
  getPdfSource(pdfPath: string, projectHandle: SaveHandle): Promise<PdfSource>

  // ---- Project editor (create / edit a project JSON) ----

  /**
   * Ask the user where the project JSON should live. Writes nothing — the
   * editor saves through `saveProject(text, location.handle)` later.
   * Returns null if the user cancels.
   */
  pickProjectLocation(suggestedName: string): Promise<ProjectLocation | null>

  /** Pick one or more PDFs to reference. Returns [] if cancelled. */
  pickPdfs(): Promise<PickedPdf[]>

  /**
   * The `pdf` values to store for these PDFs, relative to the project JSON's
   * directory. Electron computes real relative paths (POSIX separators), so
   * moving the JSON re-derives them. The browser has no paths, so it returns
   * the bare file names.
   */
  relativePdfPaths(pdfs: PickedPdf[], location: ProjectLocation | null): Promise<string[]>
}

/** True when running inside the Electron shell (preload exposed `window.slr`). */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { slr?: unknown }).slr)
}
