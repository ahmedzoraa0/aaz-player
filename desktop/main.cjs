// @ts-nocheck
const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}

const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'aaz-window-state.json');

const AUDIO_EXTS = new Set([
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'opus',
  'wma', 'aiff', 'aif', 'aifc', 'alac', 'weba', 'mka', 'mp2', 'amr', 'caf'
]);
const VIDEO_EXTS = new Set([
  'mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', 'ogv', '3gp', '3g2', 'ts', 'flv', 'mpg', 'mpeg'
]);
const SUBTITLE_EXTS = new Set(['srt', 'vtt']);
const PLAYLIST_EXTS = new Set(['xspf', 'm3u8', 'm3u', 'pls']);

let mainWindow = null;
let pendingLaunchFiles = [];
let manualUpdateCheck = false;

function sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('aaz:update-status', payload);
  }
}

function initAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    if (manualUpdateCheck) {
      sendUpdateStatus({ status: 'checking', version: app.getVersion() });
    }
  });

  autoUpdater.on('update-available', (info) => {
    manualUpdateCheck = false;
    sendUpdateStatus({
      status: 'available',
      version: info && info.version ? info.version : '',
      currentVersion: app.getVersion()
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      sendUpdateStatus({
        status: 'not-available',
        version: (info && info.version) || app.getVersion()
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus({
      status: 'downloading',
      percent: Math.round(progress && progress.percent ? progress.percent : 0)
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus({
      status: 'downloaded',
      version: info && info.version ? info.version : ''
    });
  });

  autoUpdater.on('error', (err) => {
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      sendUpdateStatus({
        status: 'error',
        message: err && err.message ? err.message : 'Update check failed'
      });
    }
  });
}

function loadWindowState() {
  try {
    const raw = fs.readFileSync(WINDOW_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.width >= 420 && parsed.height >= 500) {
      return parsed;
    }
  } catch {
    // First launch
  }
  return { width: 1200, height: 780, isMaximized: false };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify({ ...bounds, isMaximized }), 'utf8');
  } catch {
    // Non-fatal
  }
}

function scanLocalDirectory(rootDir, currentDir = rootDir, relPrefix = '') {
  const results = [];
  let entries = [];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      results.push(...scanLocalDirectory(rootDir, fullPath, `${relPrefix}${entry.name}/`));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      let kind = null;
      if (VIDEO_EXTS.has(ext)) kind = 'video';
      else if (AUDIO_EXTS.has(ext)) kind = 'audio';
      else if (SUBTITLE_EXTS.has(ext)) kind = 'subtitle';

      if (!kind) continue;

      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        size = 0;
      }

      results.push({
        key: `${relPrefix}${entry.name}`,
        name: entry.name,
        folderPath: relPrefix.replace(/\/$/, ''),
        fullPath,
        fileUrl: pathToFileURL(fullPath).toString(),
        kind,
        ext: ext.toUpperCase(),
        size
      });
    }
  }
  return results;
}

function extractSupportedPathsFromArgv(argv) {
  return argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-') && arg !== '.' && fs.existsSync(arg))
    .filter((arg) => {
      try {
        const stat = fs.statSync(arg);
        if (stat.isDirectory()) return true;
        const ext = path.extname(arg).slice(1).toLowerCase();
        return AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext) || PLAYLIST_EXTS.has(ext);
      } catch {
        return false;
      }
    });
}

function createWindow() {
  const saved = loadWindowState();
  const iconIco = path.join(__dirname, 'assets', 'icon.ico');
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  const iconPath = process.platform === 'win32' && fs.existsSync(iconIco)
    ? iconIco
    : fs.existsSync(iconPng)
      ? iconPng
      : undefined;

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 460,
    minHeight: 540,
    title: 'AAZ Player',
    icon: iconPath,
    backgroundColor: '#060b08',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  Menu.setApplicationMenu(null);

  if (saved.isMaximized) {
    mainWindow.maximize();
  }

  const packagedHtml = path.join(__dirname, 'app', 'index.html');
  const devHtml = path.join(__dirname, '..', 'index.html');
  const targetHtml = fs.existsSync(packagedHtml) ? packagedHtml : devHtml;

  mainWindow.loadFile(targetHtml);

  mainWindow.on('close', () => saveWindowState(mainWindow));

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingLaunchFiles.length > 0) {
      mainWindow.webContents.send('aaz:open-external', pendingLaunchFiles);
      pendingLaunchFiles = [];
    }
    // Silent background update check 5 seconds after startup (packaged builds only)
    if (autoUpdater && app.isPackaged) {
      setTimeout(() => {
        manualUpdateCheck = false;
        autoUpdater.checkForUpdates().catch(() => {});
      }, 5000);
    }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  pendingLaunchFiles = extractSupportedPathsFromArgv(process.argv);

  app.on('second-instance', (_event, argv) => {
    const files = extractSupportedPathsFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (files.length > 0) {
        mainWindow.webContents.send('aaz:open-external', files);
      }
    }
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.aaz.player');
    }
    initAutoUpdater();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ============================================================================
   IPC Handlers — Native Windows Folder, Files, Playlists, Pinning & Auto-Update
   ============================================================================ */
ipcMain.handle('aaz:get-app-version', () => app.getVersion());

ipcMain.handle('aaz:check-updates', async () => {
  if (!autoUpdater || !app.isPackaged) {
    return { status: 'dev-mode', version: app.getVersion() };
  }
  manualUpdateCheck = true;
  try {
    await autoUpdater.checkForUpdates();
    return { status: 'started' };
  } catch (err) {
    manualUpdateCheck = false;
    return { status: 'error', message: err && err.message ? err.message : 'Update check failed' };
  }
});

ipcMain.handle('aaz:download-update', async () => {
  if (!autoUpdater || !app.isPackaged) return false;
  try {
    await autoUpdater.downloadUpdate();
    return true;
  } catch (err) {
    sendUpdateStatus({ status: 'error', message: err && err.message ? err.message : 'Download failed' });
    return false;
  }
});

ipcMain.handle('aaz:install-update', () => {
  if (!autoUpdater || !app.isPackaged) return false;
  autoUpdater.quitAndInstall(false, true);
  return true;
});

ipcMain.handle('aaz:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'AAZ Player',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const folderPath = result.filePaths[0];
  return {
    folderPath,
    folderName: path.basename(folderPath),
    entries: scanLocalDirectory(folderPath)
  };
});

ipcMain.handle('aaz:select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'AAZ Player',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Media & Playlists',
        extensions: [...AUDIO_EXTS, ...VIDEO_EXTS, ...SUBTITLE_EXTS, ...PLAYLIST_EXTS]
      },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return inspectPathList(result.filePaths);
});

ipcMain.handle('aaz:read-folder', async (_event, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return null;
  return {
    folderPath,
    folderName: path.basename(folderPath),
    entries: scanLocalDirectory(folderPath)
  };
});

ipcMain.handle('aaz:read-text-file', async (_event, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
});

function inspectPathList(paths) {
  const entries = [];
  const playlists = [];
  for (const rawPath of paths || []) {
    let p = rawPath;
    if (typeof p === 'string' && p.startsWith('file://')) {
      try {
        p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, ''));
        if (process.platform === 'win32' && /^[A-Za-z]:/.test(p)) {
          p = p.replace(/\//g, '\\');
        } else if (process.platform !== 'win32' && !p.startsWith('/')) {
          p = '/' + p;
        }
      } catch {
        // Keep raw
      }
    }
    if (!p || !fs.existsSync(p)) continue;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      return {
        isDirectory: true,
        folderPath: p,
        folderName: path.basename(p),
        entries: scanLocalDirectory(p),
        playlists: []
      };
    } else if (stat.isFile()) {
      const name = path.basename(p);
      const ext = path.extname(name).slice(1).toLowerCase();
      if (PLAYLIST_EXTS.has(ext)) {
        playlists.push({ name, fullPath: p, content: fs.readFileSync(p, 'utf8') });
        continue;
      }
      const kind = VIDEO_EXTS.has(ext) ? 'video' : AUDIO_EXTS.has(ext) ? 'audio' : SUBTITLE_EXTS.has(ext) ? 'subtitle' : null;
      if (kind) {
        entries.push({
          key: name,
          name,
          folderPath: '',
          fullPath: p,
          fileUrl: pathToFileURL(p).toString(),
          kind,
          ext: ext.toUpperCase(),
          size: stat.size
        });
      }
    }
  }
  return { isDirectory: false, entries, playlists };
}

ipcMain.handle('aaz:inspect-paths', async (_event, paths) => {
  return inspectPathList(paths);
});

ipcMain.handle('aaz:set-always-on-top', (_event, enabled) => {
  if (!mainWindow) return false;
  mainWindow.setAlwaysOnTop(Boolean(enabled), 'floating');
  return mainWindow.isAlwaysOnTop();
});
