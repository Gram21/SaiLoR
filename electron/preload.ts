import { contextBridge, ipcRenderer } from 'electron'

/**
 * Safe bridge exposed to the renderer as `window.slr`. Mirrors the SlrBridge
 * interface in src/platform/electron.ts.
 */
contextBridge.exposeInMainWorld('slr', {
  // So the update notice can offer the installer that actually matches this
  // machine (e.g. the arm64 dmg rather than the Intel one).
  os: { platform: process.platform, arch: process.arch },

  openProject: () => ipcRenderer.invoke('project:open'),
  openPath: (filePath: string) => ipcRenderer.invoke('project:openPath', filePath),
  saveProject: (filePath: string, text: string) =>
    ipcRenderer.invoke('project:save', filePath, text),
  setProjectDir: (filePath: string) => ipcRenderer.invoke('project:setDir', filePath),

  // Project editor: pick a location / PDFs, and relativize the PDF references.
  pickSavePath: (suggestedName: string) => ipcRenderer.invoke('project:pickSavePath', suggestedName),
  pickPdfs: () => ipcRenderer.invoke('pdf:pick'),
  pickPdfFolder: () => ipcRenderer.invoke('pdf:pickFolder'),
  pickReferenceFile: () => ipcRenderer.invoke('reference:pick'),
  readPdf: (filePath: string) => ipcRenderer.invoke('pdf:read', filePath),
  peekProjects: (paths: string[]) => ipcRenderer.invoke('project:peek', paths),
  relativePaths: (fromFile: string, toFiles: string[]) =>
    ipcRenderer.invoke('paths:relative', fromFile, toFiles),
  rebasePaths: (fromFile: string, toFile: string, rels: string[]) =>
    ipcRenderer.invoke('paths:rebase', fromFile, toFile, rels),

  // AI-assisted annotation. Note what is NOT here: any way to read an API key
  // back out. The renderer can store one and use one, but never see one.
  llmConfigs: () => ipcRenderer.invoke('llm:configs'),
  saveLlmConfig: (config: unknown, apiKey?: string) =>
    ipcRenderer.invoke('llm:saveConfig', config, apiKey),
  deleteLlmConfig: (id: string) => ipcRenderer.invoke('llm:deleteConfig', id),
  callLlm: (requestId: string, request: unknown) =>
    ipcRenderer.invoke('llm:call', requestId, request),
  abortLlm: (requestId: string) => ipcRenderer.send('llm:abort', requestId),

  // Unsaved-changes coordination for a clean quit.
  setDirty: (dirty: boolean) => ipcRenderer.send('app:setDirty', dirty),
  onRequestSave: (cb: () => void) => {
    ipcRenderer.removeAllListeners('app:requestSave')
    ipcRenderer.on('app:requestSave', () => cb())
  },
  saveComplete: (ok: boolean) => ipcRenderer.send('app:saveComplete', ok),

  // Edit-menu Undo/Redo, routed to the app's annotation history.
  onUndo: (cb: () => void) => {
    ipcRenderer.removeAllListeners('app:undo')
    ipcRenderer.on('app:undo', () => cb())
  },
  onRedo: (cb: () => void) => {
    ipcRenderer.removeAllListeners('app:redo')
    ipcRenderer.on('app:redo', () => cb())
  },
})
