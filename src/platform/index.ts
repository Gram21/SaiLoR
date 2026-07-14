import type { PlatformAdapter } from './adapter'
import { isElectron } from './adapter'
import { ElectronAdapter } from './electron'
import { BrowserAdapter } from './browser'

let cached: PlatformAdapter | null = null

/** Return the adapter appropriate for the current runtime (singleton). */
export function getPlatform(): PlatformAdapter {
  if (!cached) {
    cached = isElectron() ? new ElectronAdapter() : new BrowserAdapter()
  }
  return cached
}

export type {
  PlatformAdapter,
  SaveHandle,
  PdfSource,
  OpenedProject,
  ProjectLocation,
  PickedPdf,
} from './adapter'
