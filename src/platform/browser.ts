import type { OpenedProject, PdfSource, PlatformAdapter, SaveHandle } from './adapter'
import { readRecents, pushRecent, removeRecent, type RecentEntry } from './recents'
import { idbSet, idbGet } from './idb'

const RECENTS_KEY = 'slr.recents.browser'

/** FileSystemHandle permission methods (not in the base TS DOM lib). */
interface PermissionCapableHandle {
  queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

async function ensureReadPermission(handle: FileSystemFileHandle): Promise<boolean> {
  const h = handle as unknown as PermissionCapableHandle
  const opts = { mode: 'read' as const }
  if ((await h.queryPermission?.(opts)) === 'granted') return true
  return (await h.requestPermission?.(opts)) === 'granted'
}

/**
 * Browser adapter. Two tiers:
 *  - Chromium (File System Access API): open/save/save-as *in place*, and a
 *    one-time directory grant to resolve local sibling PDFs.
 *  - Fallback (Firefox/Safari): open via <input>, save via download, and PDFs
 *    resolved by fetching the path relative to the page (works when the project
 *    is served with its pdfs/ alongside the app).
 */

interface FsApiWindow {
  showOpenFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle[]>
  showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle>
  showDirectoryPicker?: (opts?: unknown) => Promise<FileSystemDirectoryHandle>
}

function fsApi(): FsApiWindow {
  return window as unknown as FsApiWindow
}

function hasFsApi(): boolean {
  return typeof fsApi().showOpenFilePicker === 'function'
}

const JSON_PICKER = {
  types: [{ description: 'SLR project', accept: { 'application/json': ['.json'] } }],
}

export class BrowserAdapter implements PlatformAdapter {
  readonly kind = 'browser' as const

  private fileHandles = new Map<string, FileSystemFileHandle>()
  private pdfDir: FileSystemDirectoryHandle | null = null
  private nextId = 0
  /** Set when a project was loaded from a URL (server mode); PDFs resolve against it. */
  private serverBase: string | null = null

  /** Record the URL a project was fetched from, so sibling PDFs resolve correctly. */
  setServerBase(url: string): void {
    // Store an absolute URL so it can serve as a base for resolving pdf paths.
    this.serverBase = new URL(url, document.baseURI).toString()
  }

  getRecents(): RecentEntry[] {
    // Recents rely on persistent handles, which only the File System Access API provides.
    return hasFsApi() ? readRecents(RECENTS_KEY) : []
  }

  async openProject(): Promise<OpenedProject | null> {
    if (hasFsApi()) {
      let handle: FileSystemFileHandle
      try {
        ;[handle] = await fsApi().showOpenFilePicker!(JSON_PICKER)
      } catch (err) {
        if (isAbort(err)) return null
        throw err
      }
      const file = await handle.getFile()
      const text = await file.text()
      const id = this.register(handle)
      this.serverBase = null
      await this.rememberHandle(file.name, handle)
      return { text, handle: { kind: 'fsapi', path: id }, name: file.name }
    }

    // Fallback: hidden file input
    const file = await pickFileViaInput()
    if (!file) return null
    const text = await file.text()
    return { text, handle: { kind: 'download' }, name: file.name }
  }

  async openRecent(id: string): Promise<OpenedProject | null> {
    const handle = await idbGet<FileSystemFileHandle>(recentHandleKey(id))
    if (!handle) {
      removeRecent(RECENTS_KEY, id)
      return null
    }
    if (!(await ensureReadPermission(handle))) {
      // Permission denied; keep it in the list so the user can retry.
      throw new Error(`Permission to read "${id}" was denied.`)
    }
    const file = await handle.getFile()
    const text = await file.text()
    const regId = this.register(handle)
    this.serverBase = null
    pushRecent(RECENTS_KEY, { id, name: id })
    return { text, handle: { kind: 'fsapi', path: regId }, name: file.name }
  }

  /** Persist a handle + record it as a recent (keyed by file name). */
  private async rememberHandle(name: string, handle: FileSystemFileHandle): Promise<void> {
    try {
      await idbSet(recentHandleKey(name), handle)
      pushRecent(RECENTS_KEY, { id: name, name })
    } catch {
      /* IndexedDB unavailable — recents simply won't persist. */
    }
  }

  async saveProject(text: string, handle: SaveHandle): Promise<SaveHandle> {
    if (handle.kind === 'fsapi' && handle.path) {
      const fh = this.fileHandles.get(handle.path)
      if (!fh) throw new Error('Lost the file handle; use "Save as".')
      await writeFsApi(fh, text)
      return handle
    }
    // download fallback: there is no in-place location, so behave like Save as.
    downloadText(text, 'project.json')
    return handle
  }

  async saveProjectAs(
    text: string,
    suggestedName: string,
  ): Promise<{ handle: SaveHandle; name: string } | null> {
    if (hasFsApi() && typeof fsApi().showSaveFilePicker === 'function') {
      let fh: FileSystemFileHandle
      try {
        fh = await fsApi().showSaveFilePicker!({ suggestedName, ...JSON_PICKER })
      } catch (err) {
        if (isAbort(err)) return null
        throw err
      }
      await writeFsApi(fh, text)
      const id = this.register(fh)
      await this.rememberHandle(fh.name, fh)
      return { handle: { kind: 'fsapi', path: id }, name: fh.name }
    }
    downloadText(text, suggestedName)
    return { handle: { kind: 'download' }, name: suggestedName }
  }

  async getPdfSource(pdfPath: string, handle: SaveHandle): Promise<PdfSource> {
    // Local project opened via FSAPI: resolve siblings through a granted dir.
    if (handle.kind === 'fsapi' && hasFsApi() && typeof fsApi().showDirectoryPicker === 'function') {
      const file = await this.resolveViaDir(pdfPath)
      const url = URL.createObjectURL(file)
      return { url, revoke: () => URL.revokeObjectURL(url) }
    }
    // Server mode: resolve against the project URL; otherwise relative to the page.
    const base = this.serverBase ?? document.baseURI
    const abs = new URL(pdfPath, base).toString()
    const res = await fetch(abs)
    if (!res.ok) {
      throw new Error(
        `Could not load PDF "${pdfPath}" (HTTP ${res.status}). In the browser, PDFs must be served alongside the project.`,
      )
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    return { url, revoke: () => URL.revokeObjectURL(url) }
  }

  private async resolveViaDir(pdfPath: string): Promise<File> {
    if (!this.pdfDir) {
      // One-time grant of the folder that contains the PDFs.
      this.pdfDir = await fsApi().showDirectoryPicker!({ id: 'slr-pdfs', mode: 'read' })
    }
    const parts = pdfPath.split('/').filter((p) => p && p !== '.')
    let dir = this.pdfDir
    try {
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i])
      }
      const fileHandle = await dir.getFileHandle(parts[parts.length - 1])
      return await fileHandle.getFile()
    } catch {
      throw new Error(
        `PDF "${pdfPath}" was not found in the selected folder. Pick the folder that contains the project's PDFs.`,
      )
    }
  }

  private register(handle: FileSystemFileHandle): string {
    const id = `fh${this.nextId++}`
    this.fileHandles.set(id, handle)
    return id
  }
}

function recentHandleKey(id: string): string {
  return `recent:${id}`
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

async function writeFsApi(handle: FileSystemFileHandle, text: string): Promise<void> {
  const writable = await (
    handle as FileSystemFileHandle & { createWritable: () => Promise<FileSystemWritableFileStream> }
  ).createWritable()
  await writable.write(text)
  await writable.close()
}

function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function pickFileViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.style.display = 'none'
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null)
      input.remove()
    })
    // If the user cancels, there's no reliable event; resolve null on focus return.
    window.addEventListener(
      'focus',
      () => setTimeout(() => resolve(input.files?.[0] ?? null), 300),
      { once: true },
    )
    document.body.appendChild(input)
    input.click()
  })
}
