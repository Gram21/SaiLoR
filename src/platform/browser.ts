import type {
  OpenedProject,
  PdfSource,
  PickedPdf,
  PlatformAdapter,
  ProjectLocation,
  SaveHandle,
} from './adapter'
import { readRecents, pushRecent, removeRecent, replaceRecents, type RecentEntry } from './recents'
import { idbSet, idbGet, idbDelete } from './idb'
import { API_KEY_SENTINEL, type LlmConfig, type LlmHttpRequest, type LlmHttpResponse } from '../llm/types'

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

  getOsInfo(): null {
    // A web deployment has no installer to download — it updates when the server
    // redeploys — so the notice just links to the release page.
    return null
  }

  private fileHandles = new Map<string, FileSystemFileHandle>()
  private pdfDir: FileSystemDirectoryHandle | null = null
  /** Fallback when there is no FSAPI directory picker: relative path → File, from a folder <input>. */
  private pdfFileMap: Map<string, File> | null = null
  private nextId = 0
  /** Set when a project was loaded from a URL (server mode); PDFs resolve against it. */
  private serverBase: string | null = null

  /** Record the URL a project was fetched from, so sibling PDFs resolve correctly. */
  setServerBase(url: string): void {
    // Store an absolute URL so it can serve as a base for resolving pdf paths.
    this.serverBase = new URL(url, document.baseURI).toString()
    this.clearLocalPdfGrants()
  }

  /**
   * Drop whatever a *previous* project's local PDFs were resolved through —
   * the granted FSAPI directory and the folder-input map — so a newly opened
   * project always resolves its own PDFs, never a leftover grant that
   * happens to still be sitting around from the last one.
   */
  private clearLocalPdfGrants(): void {
    this.pdfDir = null
    this.pdfFileMap = null
  }

  getRecents(): RecentEntry[] {
    // Recents rely on persistent handles, which only the File System Access API provides.
    return hasFsApi() ? readRecents(RECENTS_KEY) : []
  }

  rememberProject(_handle: SaveHandle, name: string, title?: string): void {
    // The entry id is the file name (the key rememberHandle stored the handle
    // under). There is no path to show: the File System Access API exposes none.
    if (!hasFsApi()) return
    pushRecent(RECENTS_KEY, { id: name, name, title })
  }

  forgetRecent(id: string): RecentEntry[] {
    // Drop the retained handle too, so nothing is left behind in IndexedDB.
    void idbDelete(recentHandleKey(id))
    return removeRecent(RECENTS_KEY, id)
  }

  async checkRecents(entries: RecentEntry[]): Promise<RecentEntry[]> {
    const fresh = await Promise.all(
      entries.map(async (e) => {
        const handle = await idbGet<FileSystemFileHandle>(recentHandleKey(e.id))
        // Availability here means "we still hold a handle for it".
        if (!handle) return { ...e, available: false }
        return { ...e, available: true, title: await peekTitle(handle, e.title) }
      }),
    )
    replaceRecents(RECENTS_KEY, fresh)
    return fresh
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
      this.clearLocalPdfGrants()
      await this.rememberHandle(file.name, handle)
      return { text, handle: { kind: 'fsapi', path: id }, name: file.name }
    }

    // Fallback: hidden file input
    const file = await pickFileViaInput('.json,application/json')
    if (!file) return null
    const text = await file.text()
    // A stale base from a previously opened server-mode project (or an
    // earlier ?project=<url> load) must not leak into this one — <input>
    // exposes no location for this project's own PDFs to resolve against, so
    // there is nothing to set it to; leaving the old value would silently
    // resolve this project's PDFs against a different project's folder.
    this.serverBase = null
    this.clearLocalPdfGrants()
    return { text, handle: { kind: 'download' }, name: file.name }
  }

  async openRecent(id: string): Promise<OpenedProject | null> {
    const handle = await idbGet<FileSystemFileHandle>(recentHandleKey(id))
    // Keep the entry; the caller marks it unavailable rather than forgetting it.
    if (!handle) return null
    if (!(await ensureReadPermission(handle))) {
      // Permission denied; keep it in the list so the user can retry.
      throw new Error(`Permission to read "${id}" was denied.`)
    }
    const file = await handle.getFile()
    const text = await file.text()
    const regId = this.register(handle)
    this.serverBase = null
    this.clearLocalPdfGrants()
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
    downloadText(text, handle.name ?? 'project.json')
    return handle
  }

  async rebasePdfPaths(pdfPaths: string[], _from: SaveHandle, _to: SaveHandle): Promise<string[]> {
    // The File System Access API exposes no filesystem paths, so there is no way
    // to work out how the old and new locations relate. The stored paths are
    // left alone; the user keeps the PDFs alongside the JSON they saved.
    return pdfPaths
  }

  async getPdfSource(pdfPath: string, _handle: SaveHandle): Promise<PdfSource> {
    // A locally opened project (anything that isn't `?project=<url>` server
    // mode) has no URL for its PDFs to live at, so there is nothing to fetch
    // — resolve siblings through a folder the reviewer grants access to once
    // per session instead: the File System Access API's directory picker
    // where available, or a folder-picking <input> otherwise. This covers
    // every "Open project…" path uniformly (an FSAPI in-place handle, or the
    // plain <input> fallback in Firefox/Safari, or Chromium without the
    // grant) — it used to only run for the FSAPI handle, which meant every
    // other local-open path fell through to a fetch against the *app's own*
    // URL and failed there instead.
    if (!this.serverBase) {
      const file = await this.resolveLocalPdf(pdfPath)
      const url = URL.createObjectURL(file)
      return { url, revoke: () => URL.revokeObjectURL(url) }
    }
    // Server mode: resolve against the project URL.
    const base = this.serverBase
    const abs = new URL(pdfPath, base).toString()
    const res = await fetch(abs)
    if (!res.ok) {
      throw new Error(
        `Could not load PDF "${pdfPath}" (HTTP ${res.status}). In the browser, PDFs must be served alongside the project.`,
      )
    }
    const buf = await res.arrayBuffer()
    // A missing file very often does NOT surface as a non-2xx status here: a
    // dev server's SPA fallback, a static host's catch-all rewrite, or a
    // reverse proxy's login page can all answer 200 with HTML for a path that
    // doesn't actually exist. `res.ok` alone can't tell that apart from a real
    // PDF, and handing pdf.js the wrong bytes surfaces as an opaque "Invalid
    // PDF structure" that points nowhere near the actual problem — so check
    // the bytes themselves before trusting them.
    if (!hasPdfMagic(buf)) {
      throw new Error(
        `Could not load PDF "${pdfPath}": the server answered, but not with a PDF. This usually means the file isn't actually there — check that it is served at "${abs}".`,
      )
    }
    const blob = new Blob([buf], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    return { url, revoke: () => URL.revokeObjectURL(url) }
  }

  needsPdfFolderGrant(): boolean {
    return !this.serverBase && !this.pdfDir && !this.pdfFileMap
  }

  async grantPdfFolderAccess(): Promise<void> {
    if (!this.needsPdfFolderGrant()) return
    await this.ensureLocalPdfGrant()
  }

  /** Local PDF resolution: the FSAPI directory picker where available, else a folder-picking `<input>`. */
  private async resolveLocalPdf(pdfPath: string): Promise<File> {
    await this.ensureLocalPdfGrant()
    if (this.pdfDir) return this.resolveViaDir(this.pdfDir, pdfPath)
    return this.resolveViaFileMap(pdfPath)
  }

  /**
   * Makes sure `pdfDir` or `pdfFileMap` is set, prompting for one if neither
   * is — the File System Access API's directory picker where available, or a
   * folder-picking `<input>` otherwise. A no-op once either is already set,
   * so this only ever prompts once per session (per grant type). Shared by
   * `grantPdfFolderAccess` (an explicit, caller-driven prompt) and
   * `resolveLocalPdf` (a just-in-time prompt for callers — like the
   * AI-annotation flow's own `getPdfSource` call — that don't go through the
   * explicit-grant UI first).
   */
  private async ensureLocalPdfGrant(): Promise<void> {
    if (this.pdfDir || this.pdfFileMap) return
    if (hasFsApi() && typeof fsApi().showDirectoryPicker === 'function') {
      try {
        this.pdfDir = await fsApi().showDirectoryPicker!({ id: 'slr-pdfs', mode: 'read' })
      } catch (err) {
        if (isAbort(err)) {
          throw new Error("Pick the folder that contains this project's PDFs to view them.")
        }
        throw err
      }
      return
    }
    // Browsers with no File System Access API (Firefox, Safari, or Chromium
    // without the grant) still support picking a whole folder through the
    // classic `<input>` via the (despite the name, universally implemented)
    // `webkitdirectory` attribute — the browser reads every file in the tree
    // in one go, each carrying its path relative to the picked folder
    // (`webkitRelativePath`).
    const files = await pickPdfFolderViaInput()
    if (files.length === 0) {
      throw new Error("No folder was selected. Pick the folder that contains this project's PDFs to view them.")
    }
    const map = new Map<string, File>()
    for (const f of files) {
      // "<pickedFolderName>/pdfs/paper.pdf" → "pdfs/paper.pdf": the picked
      // folder's own name isn't part of the project-relative paths stored
      // in the JSON, only its contents are.
      const rel = f.webkitRelativePath.split('/').slice(1).join('/')
      if (rel) map.set(rel, f)
    }
    this.pdfFileMap = map
  }

  private async resolveViaDir(dir: FileSystemDirectoryHandle, pdfPath: string): Promise<File> {
    const parts = relParts(pdfPath)
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

  private resolveViaFileMap(pdfPath: string): File {
    const file = this.pdfFileMap?.get(relParts(pdfPath).join('/'))
    if (!file) {
      throw new Error(
        `PDF "${pdfPath}" was not found in the selected folder. Pick the folder that contains the project's PDFs.`,
      )
    }
    return file
  }

  // ---- Project editor ----

  async pickProjectLocation(suggestedName: string): Promise<ProjectLocation | null> {
    if (hasFsApi() && typeof fsApi().showSaveFilePicker === 'function') {
      let fh: FileSystemFileHandle
      try {
        fh = await fsApi().showSaveFilePicker!({ suggestedName, ...JSON_PICKER })
      } catch (err) {
        if (isAbort(err)) return null
        throw err
      }
      // Only reserve the location — the editor writes through saveProject() later.
      const id = this.register(fh)
      await this.rememberHandle(fh.name, fh)
      return { handle: { kind: 'fsapi', path: id, name: fh.name }, name: fh.name }
    }
    // No picker available: saving downloads the file, so there is no location to
    // choose — only a name, which rides on the handle so saveProject can use it.
    return { handle: { kind: 'download', name: suggestedName }, name: suggestedName }
  }

  async pickPdfs(): Promise<PickedPdf[]> {
    if (hasFsApi()) {
      let handles: FileSystemFileHandle[]
      try {
        handles = await fsApi().showOpenFilePicker!({
          multiple: true,
          types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
        })
      } catch (err) {
        if (isAbort(err)) return []
        throw err
      }
      return handles.map((h) => ({
        name: h.name,
        read: async () => (await h.getFile()).arrayBuffer(),
      }))
    }

    const files = await pickFilesViaInput()
    return files.map((f) => ({ name: f.name, read: () => f.arrayBuffer() }))
  }

  async pickPdfFolder(): Promise<PickedPdf[]> {
    // Same folder-picking mechanism `ensureLocalPdfGrant` uses for the PDF-viewer
    // grant — a directory-wide <input>, cancel-detected the same careful way (see
    // that function's comment). Here every PDF found becomes a row to import,
    // rather than an entry in a lookup map.
    const files = await pickPdfFolderViaInput()
    return files
      .filter((f) => /\.pdf$/i.test(f.name))
      .map((f) => ({ name: f.name, read: () => f.arrayBuffer() }))
  }

  async pickReferenceFile(): Promise<{ text: string; name: string } | null> {
    const file = await pickFileViaInput('.bib,.ris,.json')
    if (!file) return null
    return { text: await file.text(), name: file.name }
  }

  async relativePdfPaths(pdfs: PickedPdf[], _location: ProjectLocation | null): Promise<string[]> {
    // Neither the File System Access API nor <input type=file> exposes filesystem
    // paths, so a path relative to the project JSON cannot be computed here. Store
    // the bare file names: the user either keeps the PDFs next to the JSON, or
    // adjusts the path by hand in the editor.
    return pdfs.map((p) => p.name)
  }

  async absolutePdfPaths(pdfPaths: string[], _from: SaveHandle): Promise<(string | undefined)[]> {
    // No filesystem paths in the browser — see `relativePdfPaths`.
    return pdfPaths.map(() => undefined)
  }

  async siblingProjectLocation(_source: SaveHandle, _fileName: string): Promise<ProjectLocation | null> {
    // No paths to build one from; callers fall back to `pickProjectLocation`.
    return null
  }

  // ---- AI-assisted annotation ----
  //
  // The browser build cannot make the promises the desktop build makes, and says
  // so in the settings dialog rather than pretending otherwise:
  //
  //  * The API key is stored in localStorage, unencrypted. There is no keychain
  //    here, and no main process to hold the key out of the page's reach.
  //  * The call goes out from the page, so it is a cross-origin request and the
  //    provider must be willing to answer it. Anthropic needs an explicit opt-in
  //    header; a self-hosted OpenAI-compatible endpoint usually sends no CORS
  //    headers at all and will simply fail.

  async listLlmConfigs(): Promise<LlmConfig[]> {
    return readLlmStore().map(({ apiKey, ...rest }) => ({ ...rest, hasKey: Boolean(apiKey) }))
  }

  async saveLlmConfig(config: LlmConfig, apiKey?: string): Promise<LlmConfig[]> {
    const stored = readLlmStore()
    const existing = stored.find((c) => c.id === config.id)
    const { hasKey: _hasKey, ...rest } = config
    // A blank key field on an edit keeps the stored key — it cannot be read back.
    const next = { ...rest, apiKey: apiKey || existing?.apiKey }
    writeLlmStore(
      existing ? stored.map((c) => (c.id === config.id ? next : c)) : [...stored, next],
    )
    return this.listLlmConfigs()
  }

  async deleteLlmConfig(id: string): Promise<LlmConfig[]> {
    writeLlmStore(readLlmStore().filter((c) => c.id !== id))
    return this.listLlmConfigs()
  }

  async callLlm(request: LlmHttpRequest, signal?: AbortSignal): Promise<LlmHttpResponse> {
    const config = readLlmStore().find((c) => c.id === request.configId)
    if (!config?.apiKey) throw new Error('No API key is stored for this target.')

    const headers: Record<string, string> = Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [
        k,
        v.split(API_KEY_SENTINEL).join(config.apiKey!),
      ]),
    )
    // Anthropic blocks browser-origin calls unless the caller opts in explicitly.
    if (config.provider === 'anthropic') {
      headers['anthropic-dangerous-direct-browser-access'] = 'true'
    }

    try {
      const res = await fetch(request.url, {
        method: request.method ?? 'POST',
        headers,
        body: request.method === 'GET' ? undefined : request.body,
        signal,
      })
      return { ok: res.ok, status: res.status, body: await res.text() }
    } catch (err) {
      if (signal?.aborted) throw err
      // A cross-origin block surfaces as an opaque TypeError with no detail, which
      // would otherwise read as "the provider is down". Name the likely cause.
      throw new Error(
        `The request to ${new URL(request.url).origin} failed. A browser cannot call every ` +
          `provider directly: the endpoint must allow cross-origin requests. The desktop app ` +
          `has no such restriction. (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }

  private register(handle: FileSystemFileHandle): string {
    const id = `fh${this.nextId++}`
    this.fileHandles.set(id, handle)
    return id
  }
}

// ---------------------------------------------------------------------------
// LLM targets, persisted in localStorage (browser build only)
// ---------------------------------------------------------------------------

const LLM_KEY = 'slr.llm.configs'

/** As stored here: the public config plus the key, in the clear. */
type StoredLlmConfig = Omit<LlmConfig, 'hasKey'> & { apiKey?: string }

function readLlmStore(): StoredLlmConfig[] {
  try {
    const raw = localStorage?.getItem(LLM_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as StoredLlmConfig[]) : []
  } catch {
    return []
  }
}

function writeLlmStore(configs: StoredLlmConfig[]): void {
  try {
    localStorage?.setItem(LLM_KEY, JSON.stringify(configs))
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

/**
 * The project's current title, read straight from the file so a title changed
 * elsewhere (e.g. in the project editor) shows up.
 *
 * Only reads when permission is *already* granted — startup must never throw a
 * permission prompt at the user just to refresh a label. Without permission the
 * previously stored title is kept.
 */
async function peekTitle(
  handle: FileSystemFileHandle,
  fallback: string | undefined,
): Promise<string | undefined> {
  try {
    const perm = handle as unknown as PermissionCapableHandle
    if ((await perm.queryPermission?.({ mode: 'read' })) !== 'granted') return fallback
    const raw = JSON.parse(await (await handle.getFile()).text()) as { title?: unknown }
    return typeof raw.title === 'string' && raw.title.trim() ? raw.title : undefined
  } catch {
    return fallback
  }
}

function recentHandleKey(id: string): string {
  return `recent:${id}`
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** A stored `pdf` path, split into clean segments (drops empty parts and `.`). */
function relParts(pdfPath: string): string[] {
  return pdfPath.split('/').filter((p) => p && p !== '.')
}

/**
 * True when `buf` starts with PDF's own magic number (`%PDF-`) — the only
 * reliable way to tell "this really is a PDF" from "the server answered 200
 * with something else for this URL". `Content-Type` is not trustworthy
 * enough on its own to skip this: plenty of static hosts serve everything as
 * `application/octet-stream`, and that would make a real PDF fail the check
 * the wrong way.
 */
function hasPdfMagic(buf: ArrayBuffer): boolean {
  const head = new Uint8Array(buf, 0, Math.min(5, buf.byteLength))
  return String.fromCharCode(...head) === '%PDF-'
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

function pickFilesViaInput(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.pdf,application/pdf'
    input.style.display = 'none'
    const done = () => {
      resolve(Array.from(input.files ?? []))
      input.remove()
    }
    input.addEventListener('change', done)
    // If the user cancels, there's no reliable event; resolve on focus return.
    window.addEventListener('focus', () => setTimeout(done, 300), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

/** Picks a whole folder (recursively) via the classic `<input>`'s `webkitdirectory` attribute. */
function pickPdfFolderViaInput(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    ;(input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true
    input.multiple = true
    input.style.display = 'none'
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve(Array.from(input.files ?? []))
      input.remove()
    }
    input.addEventListener('change', finish)
    // The dedicated `cancel` event (Chrome 113+, Firefox 106+, Safari 16.4+)
    // fires only when the picker was genuinely dismissed with nothing chosen.
    // A focus-return guess is NOT safe here the way it is for a plain file
    // picker: Firefox inserts its own "Upload N files from this folder?"
    // confirmation *after* the OS folder dialog closes — and that OS dialog
    // closing already returns window focus, well before the user has
    // answered Firefox's prompt. A short focus-based timeout reads that
    // in-between moment as a cancel and resolves empty while the real answer
    // is still pending, which is exactly the bug this event replaces.
    input.addEventListener('cancel', finish)
    // Belt-and-suspenders only, for an engine with neither event: a long
    // delay so a still-pending confirmation step (above) has time to clear.
    window.addEventListener('focus', () => setTimeout(finish, 2000), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

function pickFileViaInput(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
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
