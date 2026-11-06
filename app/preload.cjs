const { contextBridge, ipcRenderer } = require('electron');
async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
contextBridge.exposeInMainWorld('xkd', {
  list: () => invoke('books:list'), create: title => invoke('books:create', title),
  update: (id, draft) => invoke('books:update', id, draft),
  importAudio: id => invoke('audio:import', id), removeAudio: (id, trackId) => invoke('audio:remove', id, trackId),
  exportNob: id => invoke('books:export', id), showExport: (id, exportId) => invoke('exports:show', id, exportId),
  chooseBatch: () => invoke('batch:choose'), convertBatch: () => invoke('batch:convert'), showBatch: () => invoke('batch:show'),
  updateState: () => invoke('updates:state'), checkUpdates: () => invoke('updates:check'),
  configureUpdates: settings => invoke('updates:configure', settings), downloadUpdate: () => invoke('updates:download'),
  cancelUpdate: () => invoke('updates:cancel'), installUpdate: () => invoke('updates:install'),
  updateStarted: () => invoke('updates:started'), openReleases: () => invoke('updates:releases'),
  onUpdateState: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('updates:state', listener); return () => ipcRenderer.removeListener('updates:state', listener); },
  onUpdateOpen: callback => { ipcRenderer.on('updates:open', callback); },
  onProgress: callback => { const listener = (_event, message) => callback(message); ipcRenderer.on('progress', listener); return () => ipcRenderer.removeListener('progress', listener); }
});
