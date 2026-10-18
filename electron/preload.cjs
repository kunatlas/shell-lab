const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellLabDesktop', {
  platform: process.platform,
  windowAction(action) {
    if (['minimize', 'maximize', 'close'].includes(action)) ipcRenderer.send('shell-lab:window', action);
  },
  copyText(text) {
    return ipcRenderer.invoke('shell-lab:clipboard-write', text);
  },
});
