import type {
  OpenedProject,
  OsInfo,
  PdfSource,
  PickedPdf,
  PlatformAdapter,
  ProjectLocation,
  SaveHandle,
} from './adapter'
import type { RecentEntry } from './recents'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse } from '../llm/types'
import type { GitPlatform } from '../git/types'
import type { PdfMark } from '../model/pdfMarks'

const UNSUPPORTED = 'SaiLoR for the web is discontinued — use the desktop app.'

/**
 * Stands in for the platform outside Electron. `App.tsx` shows a "use the
 * desktop app" notice and blocks every project-opening UI before any of this
 * can be reached from a user action — this only exists because a few reads
 * (`getRecents`) happen at store module load, before `App` ever renders. Every
 * read-only query answers with "nothing"; every action throws, as a backstop
 * in case something is ever wired up to call one of these directly.
 */
export class UnsupportedAdapter implements PlatformAdapter {
  readonly kind = 'browser' as const

  getOsInfo(): OsInfo | null {
    return null
  }

  getRecents(): RecentEntry[] {
    return []
  }

  rememberProject(): void {}

  forgetRecent(): RecentEntry[] {
    return []
  }

  async checkRecents(): Promise<RecentEntry[]> {
    return []
  }

  async openRecent(): Promise<OpenedProject | null> {
    return null
  }

  async openProject(): Promise<OpenedProject | null> {
    throw new Error(UNSUPPORTED)
  }

  async saveProject(): Promise<SaveHandle> {
    throw new Error(UNSUPPORTED)
  }

  async rebasePdfPaths(pdfPaths: string[]): Promise<string[]> {
    return pdfPaths
  }

  async getPdfSource(): Promise<PdfSource> {
    throw new Error(UNSUPPORTED)
  }

  needsPdfFolderGrant(): boolean {
    return false
  }

  async grantPdfFolderAccess(): Promise<void> {}

  async pickProjectLocation(): Promise<ProjectLocation | null> {
    return null
  }

  async pickPdfs(): Promise<PickedPdf[]> {
    return []
  }

  async pickPdfFolder(): Promise<PickedPdf[]> {
    return []
  }

  async pickReferenceFile(): Promise<{ text: string; name: string } | null> {
    return null
  }

  async relativePdfPaths(pdfs: PickedPdf[]): Promise<string[]> {
    return pdfs.map((p) => p.name)
  }

  async absolutePdfPaths(pdfPaths: string[]): Promise<(string | undefined)[]> {
    return pdfPaths.map(() => undefined)
  }

  async siblingProjectLocation(): Promise<ProjectLocation | null> {
    return null
  }

  async listLlmConfigs(): Promise<LlmConfig[]> {
    return []
  }

  async saveLlmConfig(): Promise<LlmConfig[]> {
    throw new Error(UNSUPPORTED)
  }

  async deleteLlmConfig(): Promise<LlmConfig[]> {
    return []
  }

  async callLlm(_request: LlmHttpRequest): Promise<LlmHttpResponse> {
    throw new Error(UNSUPPORTED)
  }

  getGit(): GitPlatform | null {
    return null
  }

  async embedPdfAnnotations(
    _pdfAbsPath: string,
    _marks: PdfMark[],
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    return { ok: false, error: UNSUPPORTED }
  }

  async pickPdfExportPath(): Promise<string | null> {
    return null
  }

  async pickTextExportPath(): Promise<string | null> {
    return null
  }

  async writeTextFile(): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    return { ok: false, error: UNSUPPORTED }
  }
}
