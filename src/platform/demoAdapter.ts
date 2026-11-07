import type { PlatformAdapter, SaveHandle } from './adapter'
import { DEMO_FILE_NAME, demoPdfUrl, demoProjectText } from '../demo/project'
import { DEMO_NOT_AVAILABLE, DEMO_NOT_SAVED, DEMO_NO_PDF } from '../demo/text'
import { DEMO_SCHEMA_MODE } from '../demo/schemaMode'

const DEMO_HANDLE: SaveHandle = { kind: 'download', name: DEMO_FILE_NAME }
const SCHEMA_FILE_NAME = 'project.json'
const SCHEMA_HANDLE: SaveHandle = { kind: 'download', name: SCHEMA_FILE_NAME }

/** Hands the text to the visitor as a file, the way a browser download does. */
function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const refused = (): never => {
  throw new Error(DEMO_NOT_SAVED)
}

const unavailable = (): never => {
  throw new Error(DEMO_NOT_AVAILABLE)
}

// [impl->req~plt-445~1]
// [impl->req~plt-446~1]
// [impl->req~plt-447~1]
/**
 * The platform of the online demo: one project, held in memory. Every method
 * that would read or write the disk, the network or git answers as if the user
 * had cancelled, or refuses with `DEMO_NOT_SAVED` / `DEMO_NOT_AVAILABLE`.
 * Nothing reaches local storage through this adapter, so a reload starts over.
 */
export function createDemoAdapter(): PlatformAdapter {
  return {
    kind: 'browser',
    getOsInfo: () => null,
    setWindowTitle: (title) => {
      document.title = title
    },
    getRecents: () => [],
    rememberProject: () => {},
    forgetRecent: () => [],
    checkRecents: async (entries) => entries,
    openRecent: async () => null,
    // Every open starts again from the bundled project, so a visitor who
    // reopens the demo never sees an earlier visit's edits.
    openProject: async () => ({ text: demoProjectText(), handle: DEMO_HANDLE, name: DEMO_FILE_NAME }),
    saveProject: async (text) => {
      if (!DEMO_SCHEMA_MODE) return refused()
      download(text, SCHEMA_FILE_NAME)
      return SCHEMA_HANDLE
    },
    rebasePdfPaths: async (pdfPaths) => pdfPaths,
    getPdfSource: async (pdfPath) => {
      const url = demoPdfUrl(pdfPath)
      if (url === null) throw new Error(DEMO_NO_PDF)
      return { url }
    },
    scanPdfFolder: async () => ({ files: [], known: [] }),
    needsPdfFolderGrant: () => false,
    grantPdfFolderAccess: async () => {},
    pickProjectLocation: async () => (DEMO_SCHEMA_MODE ? { handle: SCHEMA_HANDLE, name: SCHEMA_FILE_NAME } : null),
    annotationsDirUsers: async () => [],
    screeningSource: async () => null,
    writeFeedback: async () => null,
    listFeedback: async () => [],
    moveAnnotationsDir: async () => refused(),
    sharedAnnotations: async () => null,
    splitAnnotations: async () => refused(),
    pickPdfs: async () => [],
    pickPdfFolder: async () => [],
    pickReferenceFile: async () => null,
    relativePdfPaths: async (pdfs) => pdfs.map((pdf) => pdf.name),
    absolutePdfPaths: async (pdfPaths) => pdfPaths.map(() => undefined),
    siblingProjectLocation: async () => null,
    listLlmConfigs: async () => [],
    saveLlmConfig: async () => unavailable(),
    deleteLlmConfig: async () => unavailable(),
    callLlm: async () => unavailable(),
    fetchWeb: async (url) => ({
      ok: false,
      status: 0,
      url,
      contentType: '',
      body: '',
      truncated: false,
      error: DEMO_NOT_AVAILABLE,
    }),
    localRuntime: null,
    discoverLocalServer: async () => ({ ok: false, error: DEMO_NOT_AVAILABLE }),
    getGit: () => null,
    embedPdfAnnotations: async () => ({ ok: false, error: DEMO_NOT_SAVED }),
    pickPdfExportPath: async () => null,
    pickTextExportPath: async () => null,
    writeTextFile: async () => ({ ok: false, error: DEMO_NOT_SAVED }),
    checkForNativeUpdate: async () => ({ supported: false }),
    downloadNativeUpdate: async () => {},
    installNativeUpdate: async () => {},
    onNativeUpdateAvailable: () => {},
    onNativeUpdateProgress: () => {},
    onNativeUpdateDownloaded: () => {},
    onNativeUpdateError: () => {},
  }
}
