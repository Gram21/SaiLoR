import { contextBridge, ipcRenderer } from 'electron'

/**
 * Safe bridge exposed to the renderer as `window.slr`. Mirrors the SlrBridge
 * interface in src/platform/electron.ts.
 */
contextBridge.exposeInMainWorld('slr', {
  openProject: () => ipcRenderer.invoke('project:open'),
  openPath: (filePath: string) => ipcRenderer.invoke('project:openPath', filePath),
  saveProject: (filePath: string, text: string) =>
    ipcRenderer.invoke('project:save', filePath, text),
  saveProjectAs: (text: string, suggestedName: string) =>
    ipcRenderer.invoke('project:saveAs', text, suggestedName),
  setProjectDir: (filePath: string) => ipcRenderer.invoke('project:setDir', filePath),
})
