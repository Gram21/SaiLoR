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
}

/** True when running inside the Electron shell (preload exposed `window.slr`). */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { slr?: unknown }).slr)
}
