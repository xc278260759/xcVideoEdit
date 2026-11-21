'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('xc', {
  openVideo: () => ipcRenderer.invoke('video:open'),
  probe: file => ipcRenderer.invoke('video:probe', file),
  chooseOutput: (defaultPath, kind) => ipcRenderer.invoke('video:chooseOutput', defaultPath, kind),
  readAudioBinary: file => ipcRenderer.invoke('audio:read', file),
  getThumbs: file => ipcRenderer.invoke('video:thumbs', file),
  saveProject: (data, defaultPath) => ipcRenderer.invoke('project:save', data, defaultPath),
  writeProject: (file, data) => ipcRenderer.invoke('project:write', file, data),
  openProject: () => ipcRenderer.invoke('project:open'),
  exportVideo: opts => ipcRenderer.invoke('video:export', opts),
  exportSegments: opts => ipcRenderer.invoke('edit:export', opts),
  getPathForFile: file => webUtils.getPathForFile(file),
  reveal: target => ipcRenderer.invoke('shell:reveal', target),
  onProgress: cb => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('export:progress', handler)
    return () => ipcRenderer.removeListener('export:progress', handler)
  },
  platform: process.platform
})
