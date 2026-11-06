import type { PlatformAdapter, SaveHandle } from './adapter'
import { DEMO_FILE_NAME, DEMO_PDF_PATH, DEMO_PDF_URL, demoProjectText } from '../demo/project'
import { DEMO_NOT_AVAILABLE, DEMO_NOT_SAVED, DEMO_NO_PDF } from '../demo/text'

const DEMO_HANDLE: SaveHandle = { kind: 'download', name: DEMO_FILE_NAME }

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
    saveProject: async () => refused(),
    rebasePdfPaths: async (pdfPaths) => pdfPaths,
    getPdfSource: async (pdfPath) => {
      if (pdfPath !== DEMO_PDF_PATH) throw new Error(DEMO_NO_PDF)
      return { url: DEMO_PDF_URL }
    },
    scanPdfFolder: async () => ({ files: [], known: [] }),
    needsPdfFolderGrant: () => false,
    grantPdfFolderAccess: async () => {},
    pickProjectLocation: async () => null,
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
