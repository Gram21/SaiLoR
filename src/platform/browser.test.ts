import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BrowserAdapter } from './browser'
import type { SaveHandle } from './adapter'

/**
 * Two things `getPdfSource` has to get right, covered in the two describe
 * blocks below:
 *
 *  - **Server mode** (a project loaded via `?project=<url>`): fetch has to be
 *    trusted only when the bytes it returns actually are a PDF. A dev
 *    server's SPA fallback, a static host's catch-all rewrite, or a reverse
 *    proxy's login page can all answer 200 with HTML for a path that doesn't
 *    exist — `res.ok` alone can't tell that apart from a real PDF, and
 *    handing pdf.js the wrong bytes surfaces as its own opaque "Invalid PDF
 *    structure" pointing nowhere near the real problem.
 *  - **A locally opened project** (FSAPI handle, or the plain `<input>`
 *    fallback in Firefox/Safari): there is no URL for its PDFs to live at,
 *    so this must never fall through to a fetch at all — it resolves
 *    through a folder the reviewer grants access to once per session.
 *
 * Response bodies in the server-mode tests are plain strings, not `Blob`s —
 * jsdom's `Blob` is missing `arrayBuffer`/`text`/`stream` entirely (confirmed:
 * `res.blob()` returns an object none of those exist on), and even passing
 * one as a `Response` body gets silently coerced to the literal string
 * "[object Blob]" rather than its content. A plain string body sidesteps
 * that jsdom gap; `Response`/`fetch` themselves are real (undici), so this
 * still exercises `getPdfSource`'s actual `res.arrayBuffer()` path.
 */

const DOWNLOAD_HANDLE: SaveHandle = { kind: 'download' }
const SERVER_BASE = 'http://example.test/project.json'

// jsdom has no real object-URL implementation at all.
URL.createObjectURL = vi.fn(() => 'blob:mock-url')
URL.revokeObjectURL = vi.fn()

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('getPdfSource (server mode): validates the bytes, not just the HTTP status', () => {
  function serverAdapter(): BrowserAdapter {
    const adapter = new BrowserAdapter()
    adapter.setServerBase(SERVER_BASE)
    return adapter
  }

  it('accepts a response that actually starts with the PDF magic number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('%PDF-1.4\n...', { status: 200 })),
    )
    const src = await serverAdapter().getPdfSource('pdfs/paper-a.pdf', DOWNLOAD_HANDLE)
    expect(src.url).toBe('blob:mock-url')
    src.revoke?.()
  })

  it('rejects a 200 response whose body is not a PDF (an SPA fallback page, a login page…)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><html>...', { status: 200 })),
    )
    await expect(serverAdapter().getPdfSource('pdfs/missing.pdf', DOWNLOAD_HANDLE)).rejects.toThrow(
      /not with a PDF/i,
    )
  })

  it('still reports a plain HTTP failure as a failure, not a "not a PDF" message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    )
    await expect(serverAdapter().getPdfSource('pdfs/missing.pdf', DOWNLOAD_HANDLE)).rejects.toThrow(
      /404/,
    )
  })

  it('is not fooled by a declared PDF content-type on a body that is not one', async () => {
    // Content-Type is the server's claim, not proof — plenty of static hosts
    // serve everything as application/octet-stream, and a misconfigured one
    // could just as easily mislabel HTML as application/pdf. The magic-number
    // check must look at the actual bytes regardless of what the header says.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>fooled you</html>', {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          }),
      ),
    )
    await expect(serverAdapter().getPdfSource('pdfs/missing.pdf', DOWNLOAD_HANDLE)).rejects.toThrow(
      /not with a PDF/i,
    )
  })

  it('rejects an empty body rather than reading past the end of the buffer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 })),
    )
    await expect(serverAdapter().getPdfSource('pdfs/missing.pdf', DOWNLOAD_HANDLE)).rejects.toThrow(
      /not with a PDF/i,
    )
  })
})

/** A fake picked file, carrying the path a folder `<input>` reports it at. */
function fileAt(relPath: string, content = '%PDF-1.4'): File {
  const file = new File([content], relPath.split('/').pop()!, { type: 'application/pdf' })
  Object.defineProperty(file, 'webkitRelativePath', { value: relPath, configurable: true })
  return file
}

/**
 * jsdom has no real folder picker: intercept the `<input>` `resolveViaFolderInput`
 * creates and make `.click()` immediately "pick" `files`, synchronously firing
 * `change` — the same shape a real folder pick produces (`webkitRelativePath`
 * on each file, prefixed with the picked folder's own name).
 */
function mockFolderPicker(files: File[]) {
  const real = document.createElement.bind(document)
  return vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = real(tag)
    if (tag === 'input') {
      const input = el as HTMLInputElement
      input.click = () => {
        Object.defineProperty(input, 'files', { value: files, configurable: true })
        input.dispatchEvent(new Event('change'))
      }
    }
    return el
  })
}

describe('getPdfSource (local project): resolves through a picked folder, never a fetch', () => {
  it('builds the path map from webkitRelativePath, stripping the picked folder\'s own name', async () => {
    const spy = mockFolderPicker([
      fileAt('MyProject/pdfs/paper-a.pdf'),
      fileAt('MyProject/pdfs/sub/paper-b.pdf'),
    ])
    const adapter = new BrowserAdapter()
    const src = await adapter.getPdfSource('pdfs/sub/paper-b.pdf', DOWNLOAD_HANDLE)
    expect(src.url).toBe('blob:mock-url')
    spy.mockRestore()
  })

  it('throws a clear, path-naming error when the picked folder lacks the file', async () => {
    const spy = mockFolderPicker([fileAt('MyProject/pdfs/other.pdf')])
    const adapter = new BrowserAdapter()
    await expect(adapter.getPdfSource('pdfs/paper-a.pdf', DOWNLOAD_HANDLE)).rejects.toThrow(
      /"pdfs\/paper-a\.pdf" was not found/,
    )
    spy.mockRestore()
  })

  it('never calls fetch for a locally opened project — there is no URL for its PDFs to live at', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const spy = mockFolderPicker([fileAt('MyProject/pdfs/paper-a.pdf')])
    const adapter = new BrowserAdapter()
    await adapter.getPdfSource('pdfs/paper-a.pdf', DOWNLOAD_HANDLE)
    expect(fetchMock).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('prompts for the folder only once per session, reusing it for later PDFs', async () => {
    const spy = mockFolderPicker([
      fileAt('MyProject/pdfs/paper-a.pdf'),
      fileAt('MyProject/pdfs/paper-b.pdf'),
    ])
    const adapter = new BrowserAdapter()
    await adapter.getPdfSource('pdfs/paper-a.pdf', DOWNLOAD_HANDLE)
    await adapter.getPdfSource('pdfs/paper-b.pdf', DOWNLOAD_HANDLE)
    // Only the one folder-picking <input> should ever have been created.
    expect(spy.mock.calls.filter(([tag]) => tag === 'input')).toHaveLength(1)
    spy.mockRestore()
  })

  it('resolves empty via the dedicated cancel event, not a focus guess', async () => {
    const real = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = real(tag)
      if (tag === 'input') (el as HTMLInputElement).click = () => el.dispatchEvent(new Event('cancel'))
      return el
    })
    const adapter = new BrowserAdapter()
    await expect(adapter.getPdfSource('pdfs/paper-a.pdf', DOWNLOAD_HANDLE)).rejects.toThrow(
      /no folder was selected/i,
    )
    spy.mockRestore()
  })

  it('waits past an early focus-return for the real selection, instead of reading it as a cancel', async () => {
    // Regression test for the exact bug this replaced: Firefox inserts its
    // own "Upload N files from this folder?" confirmation *after* the OS
    // folder dialog closes, and that OS dialog closing already returns
    // window focus — well before the user has answered Firefox's prompt. The
    // old focus-based-guess logic read that gap as "the user cancelled" and
    // resolved empty while the real files were still on their way.
    vi.useFakeTimers()
    let capturedInput: HTMLInputElement | null = null
    const real = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = real(tag)
      if (tag === 'input') {
        capturedInput = el as HTMLInputElement
        // The OS dialog "closes" the instant it's opened, in this simulation.
        el.click = () => window.dispatchEvent(new Event('focus'))
      }
      return el
    })
    const adapter = new BrowserAdapter()
    const pending = adapter.getPdfSource('pdfs/paper-a.pdf', DOWNLOAD_HANDLE)

    // Focus has returned, but the real selection hasn't landed yet — assert
    // nothing has settled prematurely before advancing further.
    await vi.advanceTimersByTimeAsync(500)

    // The user now answers Firefox's own confirmation, well inside the
    // fallback window: the real `change` event finally arrives.
    Object.defineProperty(capturedInput!, 'files', {
      value: [fileAt('MyProject/pdfs/paper-a.pdf')],
      configurable: true,
    })
    capturedInput!.dispatchEvent(new Event('change'))

    const src = await pending
    expect(src.url).toBe('blob:mock-url')
    spy.mockRestore()
    vi.useRealTimers()
  })
})

describe('needsPdfFolderGrant / grantPdfFolderAccess', () => {
  it('is true for a fresh local project, false once granted, false in server mode', async () => {
    const local = new BrowserAdapter()
    expect(local.needsPdfFolderGrant()).toBe(true)

    const spy = mockFolderPicker([fileAt('MyProject/pdfs/paper-a.pdf')])
    await local.grantPdfFolderAccess()
    expect(local.needsPdfFolderGrant()).toBe(false)
    spy.mockRestore()

    const server = new BrowserAdapter()
    server.setServerBase(SERVER_BASE)
    expect(server.needsPdfFolderGrant()).toBe(false)
  })

  it('lets getPdfSource resolve without prompting again once granted explicitly', async () => {
    const adapter = new BrowserAdapter()
    const spy = mockFolderPicker([fileAt('MyProject/pdfs/paper-a.pdf')])
    await adapter.grantPdfFolderAccess()

    // The <input> must not be created a second time: getPdfSource should
    // find the grant already in place and go straight to resolving.
    const inputsBefore = spy.mock.calls.filter(([tag]) => tag === 'input').length
    const src = await adapter.getPdfSource('pdfs/paper-a.pdf', DOWNLOAD_HANDLE)
    expect(src.url).toBe('blob:mock-url')
    expect(spy.mock.calls.filter(([tag]) => tag === 'input')).toHaveLength(inputsBefore)
    spy.mockRestore()
  })

  it('is a no-op when called again after a successful grant', async () => {
    const adapter = new BrowserAdapter()
    const spy = mockFolderPicker([fileAt('MyProject/pdfs/paper-a.pdf')])
    await adapter.grantPdfFolderAccess()
    await adapter.grantPdfFolderAccess()
    expect(spy.mock.calls.filter(([tag]) => tag === 'input')).toHaveLength(1)
    spy.mockRestore()
  })

  it('propagates a clear error when the user picks nothing, leaving needsPdfFolderGrant true', async () => {
    const adapter = new BrowserAdapter()
    const spy = mockFolderPicker([])
    await expect(adapter.grantPdfFolderAccess()).rejects.toThrow(/no folder was selected/i)
    expect(adapter.needsPdfFolderGrant()).toBe(true)
    spy.mockRestore()
  })
})

describe('absolutePdfPaths / siblingProjectLocation: no filesystem paths in the browser', () => {
  it('absolutePdfPaths returns undefined for every entry', async () => {
    const adapter = new BrowserAdapter()
    const result = await adapter.absolutePdfPaths(['a.pdf', 'sub/b.pdf'], DOWNLOAD_HANDLE)
    expect(result).toEqual([undefined, undefined])
  })

  it('siblingProjectLocation returns null so callers fall back to pickProjectLocation', async () => {
    const adapter = new BrowserAdapter()
    const result = await adapter.siblingProjectLocation(DOWNLOAD_HANDLE, 'project.json')
    expect(result).toBeNull()
  })
})

/**
 * Recents identify a *file*, not a file name. Two reviews both saved as
 * `review.json` used to collapse into one entry and — worse — one IndexedDB
 * key, so the second open overwrote the first's handle and the surviving entry
 * opened the wrong project.
 *
 * `localStorage` is not exposed in this test environment (recents.ts wraps
 * every touch in try/catch, so without a stub `pushRecent` silently no-ops and
 * there is nothing to assert), and IndexedDB is not either — both are stubbed
 * here rather than globally, so no other test file's behaviour changes.
 */
describe('recents keyed by file identity', () => {
  const idb = new Map<string, unknown>()

  /** A handle that reports `isSameEntry` only against itself. */
  function fakeHandle(name: string) {
    const h = {
      name,
      kind: 'file' as const,
      isSameEntry: (other: unknown) => Promise.resolve(other === h),
    }
    return h
  }

  beforeEach(() => {
    idb.clear()
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    })
    vi.doMock('./idb', () => ({
      idbGet: async (k: string) => idb.get(k),
      idbSet: async (k: string, v: unknown) => void idb.set(k, v),
      idbDelete: async (k: string) => void idb.delete(k),
    }))
    // `getRecents` returns nothing at all unless the File System Access API is
    // present — recents depend on persistent handles, which only it provides.
    vi.stubGlobal('showOpenFilePicker', () => Promise.resolve([]))
  })

  it('keeps two same-named projects apart, and does not duplicate a re-open', async () => {
    vi.resetModules()
    const { BrowserAdapter: Adapter } = await import('./browser')
    const a = new Adapter()
    const one = fakeHandle('review.json')
    const two = fakeHandle('review.json')

    const remember = (
      a as unknown as { rememberHandle: (n: string, h: unknown) => Promise<void> }
    ).rememberHandle.bind(a)

    await remember('review.json', one)
    await remember('review.json', two)
    expect(a.getRecents()).toHaveLength(2)
    // Distinct ids means distinct IndexedDB keys: neither handle overwrote the
    // other, which is the failure that made the survivor open the wrong project.
    expect(new Set(a.getRecents().map((e) => e.id)).size).toBe(2)

    // Re-opening the first reuses its entry rather than minting a third.
    await remember('review.json', one)
    expect(a.getRecents()).toHaveLength(2)
  })
})
