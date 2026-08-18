import type { PlatformAdapter } from './adapter'
import { isElectron } from './adapter'
import { ElectronAdapter } from './electron'
import { createUnsupportedAdapter } from './unsupported'

let cached: PlatformAdapter | null = null

/**
 * Return the adapter appropriate for the current runtime (singleton).
 *
 * SaiLoR for the web is discontinued (see `App.tsx`'s `isElectron()` gate,
 * which blocks every project-opening UI before it can call anything below) —
 * so the non-Electron case only needs to exist at all because store.ts reads
 * `getPlatform().getRecents()` at module load, before `App` ever renders.
 * `createUnsupportedAdapter` answers that safely; nothing else should ever
 * reach it.
 */
export function getPlatform(): PlatformAdapter {
  if (!cached) {
    cached = isElectron() ? new ElectronAdapter() : createUnsupportedAdapter()
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
