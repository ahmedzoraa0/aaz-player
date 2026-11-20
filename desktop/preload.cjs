// @ts-nocheck
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aazDesktop', {
  isElectron: true,
  openNewWindow: () => ipcRenderer.invoke('aaz:new-window'),
  getAppVersion: () => ipcRenderer.invoke('aaz:get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('aaz:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('aaz:download-update'),
  installUpdate: () => ipcRenderer.invoke('aaz:install-update'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('aaz:update-status', (_event, payload) => callback(payload));
  },
  selectFolder: () => ipcRenderer.invoke('aaz:select-folder'),
  selectFiles: () => ipcRenderer.invoke('aaz:select-files'),
  readFolder: (folderPath) => ipcRenderer.invoke('aaz:read-folder', folderPath),
  readTextFile: (filePath) => ipcRenderer.invoke('aaz:read-text-file', filePath),
  findNearbySubtitle: (videoFullPath) => ipcRenderer.invoke('aaz:find-nearby-subtitle', videoFullPath),
  inspectPaths: (paths) => ipcRenderer.invoke('aaz:inspect-paths', paths),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('aaz:set-always-on-top', enabled),
  setWindowFullscreen: (enabled) => ipcRenderer.invoke('aaz:set-fullscreen', enabled),
  isWindowFullscreen: () => ipcRenderer.invoke('aaz:is-fullscreen'),
  listSystemFonts: () => ipcRenderer.invoke('aaz:list-system-fonts'),
  onOpenExternal: (callback) => {
    ipcRenderer.on('aaz:open-external', (_event, paths) => callback(paths));
  }
});
