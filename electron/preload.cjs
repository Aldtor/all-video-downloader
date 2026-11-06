const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frameHarbor', {
  checkEngine: () => ipcRenderer.invoke('engine:status'),
  inspectUrl: (url) => ipcRenderer.invoke('url:inspect', String(url || '')),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  startDownload: (request) => ipcRenderer.invoke('download:start', {
    url: String(request?.url || ''),
    quality: String(request?.quality || 'best'),
    outputDirectory: String(request?.outputDirectory || ''),
  }),
  cancelDownload: (id) => ipcRenderer.invoke('download:cancel', String(id || '')),
  onProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A progress callback is required.');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('download:progress', listener);
    return () => ipcRenderer.removeListener('download:progress', listener);
  },
  onFinished: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A completion callback is required.');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('download:finished', listener);
    return () => ipcRenderer.removeListener('download:finished', listener);
  },
});
