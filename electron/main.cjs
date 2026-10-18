const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('node:path');

let mainWindow;
const address = process.env.SHELL_LAB_DESKTOP_URL;
function localAddress(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port) && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.whenReady().then(async () => {
    if (!localAddress(address)) throw new Error('请使用 npm run desktop 启动 ShellLab。');
    mainWindow = new BrowserWindow({
      width: 1440, height: 900, minWidth: 800, minHeight: 600,
      title: 'ShellLab', backgroundColor: '#faf9f6', show: false,
      frame: process.platform === 'darwin', titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 14 }, autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    mainWindow.setMenu(null);
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
    // The desktop bridge is only available to our local application.
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (url !== address) event.preventDefault();
    });
    mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    mainWindow.webContents.session.setPermissionCheckHandler(() => false);
    const trusted = (event) => Boolean(mainWindow
      && event.sender === mainWindow.webContents
      && event.senderFrame === mainWindow.webContents.mainFrame
      && event.senderFrame.url === address);
    ipcMain.on('shell-lab:window', (event, action) => {
      if (!trusted(event)) return;
      if (action === 'minimize') mainWindow.minimize();
      else if (action === 'maximize') {
        if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
      } else if (action === 'close') mainWindow.close();
    });
    // Writes stay in the main process so the renderer keeps its deny-all permission policy.
    ipcMain.handle('shell-lab:clipboard-write', (event, text) => {
      if (!trusted(event)) throw new Error('剪贴板写入被拒绝。');
      if (typeof text !== 'string' || text.length > 100_000) throw new Error('无效的剪贴板内容。');
      clipboard.writeText(text);
    });
    await mainWindow.loadURL(address);
  }).catch((error) => {
    dialog.showErrorBox('ShellLab 无法启动', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
