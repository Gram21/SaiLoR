import type {
  OpenedProject,
  PdfSource,
  PickedPdf,
  PlatformAdapter,
  ProjectLocation,
  SaveHandle,
} from './adapter'
import { readRecents, pushRecent, removeRecent, type RecentEntry } from './recents'

const RECENTS_KEY = 'slr.recents.electron'

/** Shape of the API exposed by electron/preload.ts on `window.slr`. */
export interface SlrBridge {
  openProject(): Promise<{ path: string; text: string } | null>
  /** Read a specific file by absolute path (for recent files). Null if missing. */
  openPath(path: string): Promise<{ path: string; text: string } | null>
  saveProject(path: string, text: string): Promise<void>
  saveProjectAs(
    text: string,
    suggestedName: string,
  ): Promise<{ path: string } | null>
  /** Register the project's base directory so slr-file:// can resolve PDFs. */
  setProjectDir(path: string): Promise<void>
  /** Pick a location for a project JSON without writing it. Null if cancelled. */
  pickSavePath(suggestedName: string): Promise<{ path: string } | null>
  /** Pick PDFs to reference. Returns their absolute paths, [] if cancelled. */
  pickPdfs(): Promise<string[]>
  /** Paths of `toFiles` relative to `fromFile`'s directory, POSIX-separated. */
  relativePaths(fromFile: string, toFiles: string[]): Promise<string[]>
  /** Unsaved-changes coordination for a clean quit. */
  setDirty(dirty: boolean): void
  onRequestSave(cb: () => void): void
  saveComplete(ok: boolean): void
  /** Edit-menu Undo/Redo routed to the app's annotation history. */
  onUndo(cb: () => void): void
  onRedo(cb: () => void): void
}

function bridge(): SlrBridge {
  return (window as unknown as { slr: SlrBridge }).slr
}

/** Electron adapter: native dialogs + fs via IPC, PDFs via the slr-file:// protocol. */
export class ElectronAdapter implements PlatformAdapter {
  readonly kind = 'electron' as const

  getRecents(): RecentEntry[] {
    return readRecents(RECENTS_KEY)
  }

  async openProject(): Promise<OpenedProject | null> {
    const res = await bridge().openProject()
    if (!res) return null
    await bridge().setProjectDir(res.path)
    pushRecent(RECENTS_KEY, { id: res.path, name: baseName(res.path) })
    return {
      text: res.text,
      handle: { kind: 'electron', path: res.path },
      name: baseName(res.path),
    }
  }

  async openRecent(id: string): Promise<OpenedProject | null> {
    const res = await bridge().openPath(id)
    if (!res) {
      // File moved or deleted — drop it from the list.
      removeRecent(RECENTS_KEY, id)
      return null
    }
    await bridge().setProjectDir(res.path)
    pushRecent(RECENTS_KEY, { id: res.path, name: baseName(res.path) })
    return {
      text: res.text,
      handle: { kind: 'electron', path: res.path },
      name: baseName(res.path),
    }
  }

  async saveProject(text: string, handle: SaveHandle): Promise<SaveHandle> {
    if (!handle.path) throw new Error('No file path; use "Save as".')
    await bridge().saveProject(handle.path, text)
    return handle
  }

  async saveProjectAs(
    text: string,
    suggestedName: string,
  ): Promise<{ handle: SaveHandle; name: string } | null> {
    const res = await bridge().saveProjectAs(text, suggestedName)
    if (!res) return null
    await bridge().setProjectDir(res.path)
    pushRecent(RECENTS_KEY, { id: res.path, name: baseName(res.path) })
    return { handle: { kind: 'electron', path: res.path }, name: baseName(res.path) }
  }

  async getPdfSource(pdfPath: string, projectHandle: SaveHandle): Promise<PdfSource> {
    // Re-assert the base directory from the handle of the project we're actually
    // rendering. The project editor repoints it when picking a new location, so
    // trusting whatever was set last would resolve PDFs against the wrong dir.
    if (projectHandle?.path) await bridge().setProjectDir(projectHandle.path)
    // The main process serves files from the project dir via slr-file://.
    // Encode each path segment but keep the separators.
    const encoded = pdfPath
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')
    return { url: `slr-file://project/${encoded}` }
  }

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
    return paths.map((p) => ({ name: baseName(p), path: p }))
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
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}
