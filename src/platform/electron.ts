import type { OpenedProject, PdfSource, PlatformAdapter, SaveHandle } from './adapter'

/** Shape of the API exposed by electron/preload.ts on `window.slr`. */
export interface SlrBridge {
  openProject(): Promise<{ path: string; text: string } | null>
  saveProject(path: string, text: string): Promise<void>
  saveProjectAs(
    text: string,
    suggestedName: string,
  ): Promise<{ path: string } | null>
  /** Register the project's base directory so slr-file:// can resolve PDFs. */
  setProjectDir(path: string): Promise<void>
}

function bridge(): SlrBridge {
  return (window as unknown as { slr: SlrBridge }).slr
}

/** Electron adapter: native dialogs + fs via IPC, PDFs via the slr-file:// protocol. */
export class ElectronAdapter implements PlatformAdapter {
  readonly kind = 'electron' as const

  async openProject(): Promise<OpenedProject | null> {
    const res = await bridge().openProject()
    if (!res) return null
    await bridge().setProjectDir(res.path)
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
    return { handle: { kind: 'electron', path: res.path }, name: baseName(res.path) }
  }

  async getPdfSource(pdfPath: string): Promise<PdfSource> {
    // The main process serves files from the project dir via slr-file://.
    // Encode each path segment but keep the separators.
    const encoded = pdfPath
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')
    return { url: `slr-file://project/${encoded}` }
  }
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}
