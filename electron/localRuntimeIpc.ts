import type { IpcMain } from 'electron'
import type { LocalRuntime } from './localRuntime'
import { LOCAL_MODEL_CATALOG, findCatalogEntry } from '../src/llm/localCatalog'

const idOf = (v: unknown): string => {
  const e = findCatalogEntry(v)
  if (!e) throw new Error('Unknown local model.')
  return e.id
}

/** Wire `local:*` channels. The renderer passes catalog ids only; everything else is decided in `localRuntime.ts`. */
export function registerLocalRuntimeIpc(ipcMain: IpcMain, rt: LocalRuntime): void {
  ipcMain.handle('local:probe', () => rt.probe())
  ipcMain.handle('local:catalog', () => LOCAL_MODEL_CATALOG)
  ipcMain.handle('local:runtime', () => rt.runtime())
  ipcMain.handle('local:runtimePlan', () => rt.runtimePlan())
  ipcMain.handle('local:runtimeInstall', () => rt.runtimeInstall())
  ipcMain.handle('local:modelPlan', (_e, id: unknown) => rt.modelPlan(idOf(id)))
  ipcMain.handle('local:modelInstall', (_e, id: unknown) => rt.modelInstall(idOf(id)))
  ipcMain.handle('local:cancel', (_e, id: unknown) => rt.cancel(id === 'runtime' ? 'runtime' : idOf(id)))
  ipcMain.handle('local:installed', () => rt.installed())
  ipcMain.handle('local:remove', (_e, id: unknown) => rt.remove(idOf(id)))
  ipcMain.handle('local:start', (_e, id: unknown) => rt.start(idOf(id)))
  ipcMain.handle('local:stop', (_e, id: unknown) => rt.stop(idOf(id)))
  ipcMain.handle('local:status', () => rt.status())
  ipcMain.handle('local:logs', (_e, id: unknown) => rt.logs(idOf(id)))
}
