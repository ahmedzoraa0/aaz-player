// @ts-nocheck
const { app, BrowserWindow, dialog, ipcMain, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
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

const windows = new Set();
let pendingLaunchFiles = [];
let manualUpdateCheck = false;
let updateCheckScheduled = false;

function getPrimaryWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  for (const win of windows) {
    if (!win.isDestroyed()) return win;
  }
  return null;
}

function sendUpdateStatus(payload) {
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('aaz:update-status', payload);
    }
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

function createWindow(isSecondary = false) {
  const saved = loadWindowState();
  const iconIco = path.join(__dirname, 'assets', 'icon.ico');
  const iconPng = path.join(__dirname, 'assets', 'icon.png');
  const iconPath = process.platform === 'win32' && fs.existsSync(iconIco)
    ? iconIco
    : fs.existsSync(iconPng)
      ? iconPng
      : undefined;

  // Offset secondary windows slightly so both windows are immediately visible side-by-side
  const offset = isSecondary ? (windows.size * 34) : 0;

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: Number.isFinite(saved.x) ? saved.x + offset : undefined,
    y: Number.isFinite(saved.y) ? saved.y + offset : undefined,
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

  windows.add(win);
  Menu.setApplicationMenu(null);

  if (!isSecondary && saved.isMaximized) {
    win.maximize();
  }

  const packagedHtml = path.join(__dirname, 'app', 'index.html');
  const devHtml = path.join(__dirname, '..', 'index.html');
  const targetHtml = fs.existsSync(packagedHtml) ? packagedHtml : devHtml;

  win.loadFile(targetHtml);

  win.on('close', () => {
    if (windows.size === 1) saveWindowState(win);
  });

  win.on('closed', () => {
    windows.delete(win);
  });

  win.webContents.on('did-finish-load', () => {
    if (!isSecondary && pendingLaunchFiles.length > 0) {
      win.webContents.send('aaz:open-external', pendingLaunchFiles);
      pendingLaunchFiles = [];
    }
    if (!updateCheckScheduled && autoUpdater && app.isPackaged) {
      updateCheckScheduled = true;
      setTimeout(() => {
        manualUpdateCheck = false;
        autoUpdater.checkForUpdates().catch(() => {});
      }, 5000);
    }
  });

  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  pendingLaunchFiles = extractSupportedPathsFromArgv(process.argv);

  app.on('second-instance', (_event, argv) => {
    const files = extractSupportedPathsFromArgv(argv);
    const targetWin = getPrimaryWindow();
    if (targetWin) {
      if (targetWin.isMinimized()) targetWin.restore();
      targetWin.focus();
      if (files.length > 0) {
        targetWin.webContents.send('aaz:open-external', files);
      }
    } else {
      createWindow(false);
    }
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.aaz.player');
    }

    // Allow fullscreen, audio output device selection, media & local fonts natively
    const ALLOWED_PERMISSIONS = new Set([
      'fullscreen',
      'media',
      'speaker-selection',
      'audioCapture',
      'pointerLock',
      'window-management',
      'local-fonts',
      'clipboard-read',
      'clipboard-sanitized-write'
    ]);
    if (session && session.defaultSession) {
      session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
        return ALLOWED_PERMISSIONS.has(permission);
      });
      session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(ALLOWED_PERMISSIONS.has(permission));
      });
    }

    initAutoUpdater();
    createWindow(false);
    app.on('activate', () => {
      if (windows.size === 0) createWindow(false);
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ============================================================================
   IPC Handlers — Multi-Window, Folders, Files, Playlists, Pinning & Auto-Update
   ============================================================================ */
ipcMain.handle('aaz:new-window', () => {
  createWindow(true);
  return true;
});

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

ipcMain.handle('aaz:select-folder', async (event) => {
  const ownerWin = BrowserWindow.fromWebContents(event.sender) || getPrimaryWindow();
  const result = await dialog.showOpenDialog(ownerWin, {
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

ipcMain.handle('aaz:select-files', async (event) => {
  const ownerWin = BrowserWindow.fromWebContents(event.sender) || getPrimaryWindow();
  const result = await dialog.showOpenDialog(ownerWin, {
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

function decodeTextBufferSmart(buf) {
  if (!buf || !buf.length) return '';
  // UTF-16 LE / BE BOM support
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    try { return new TextDecoder('utf-16le').decode(buf); } catch {}
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    try { return new TextDecoder('utf-16be').decode(buf); } catch {}
  }
  // Strict UTF-8 check; if invalid bytes (e.g. Arabic ANSI Windows-1256 .srt), fallback cleanly!
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('windows-1256').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

ipcMain.handle('aaz:read-text-file', async (_event, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    return decodeTextBufferSmart(buf);
  } catch {
    return null;
  }
});

const SUB_NOISE_TOKENS = new Set([
  '1080p', '720p', '480p', '2160p', '4k', 'uhd', 'hd', 'sd', 'hdr', 'hdr10',
  'bluray', 'bdrip', 'brrip', 'webrip', 'webdl', 'web', 'dl', 'hdtv', 'dvdrip', 'cam', 'ts',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', '10bit', '8bit',
  'aac', 'ac3', 'dts', 'ddp5', 'dd5', 'atmos', 'mp3', 'flac',
  'yts', 'yify', 'rarbg', 'etrg', 'evo', 'nf', 'amzn', 'dsnp', 'hmax', 'extended', 'unrated', 'repack', 'proper',
  'ar', 'ara', 'arabic', 'en', 'eng', 'english', 'sub', 'subs', 'subtitle', 'subtitles', 'sdh', 'hi', 'forced', 'cc'
]);

const SUB_LANG_SUFFIX_RE = /(?:[._\-\s\[(]+(?:ar|ara|arabic|en|eng|english|sdh|hi|forced|cc|sub|subs|default)[\])]*)+\s*$/i;
const SUB_ARABIC_HINT_RE = /(?:^|[._\-\s\[(])(ar|ara|arabic|عربي|عربية|ترجمة)(?:$|[._\-\s\])])/i;
const SUB_EPISODE_RE = /\b(s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3}|ep?\s*\d{1,3})\b/i;

function normalizeMediaName(rawName) {
  const noExt = String(rawName || '').replace(/\.[^.]+$/, '');
  const stripped = noExt.replace(SUB_LANG_SUFFIX_RE, '').trim();
  return (stripped || noExt)
    .toLowerCase()
    .replace(/[._\-\[\](){}+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCoreTokens(normName) {
  return normName
    .split(' ')
    .filter((tok) => tok.length > 1 && !SUB_NOISE_TOKENS.has(tok));
}

function extractEpisodeTag(normName) {
  const m = normName.match(SUB_EPISODE_RE);
  if (!m) return '';
  return m[1].replace(/\s+/g, '').replace(/^ep(\d)/, 'e$1');
}

function scoreSubtitleCandidate(videoBaseName, subFileName, distancePenalty, isOnlyVideoInDir, subCountInSameDir) {
  const vRawNoExt = videoBaseName.replace(/\.[^.]+$/, '').toLowerCase();
  const sRawNoExt = subFileName.replace(/\.[^.]+$/, '').toLowerCase();

  let score = 0;
  const vNorm = normalizeMediaName(videoBaseName);
  const sNorm = normalizeMediaName(subFileName);

  if (vRawNoExt === sRawNoExt) {
    score = 1000;
  } else if (vNorm && sNorm && vNorm === sNorm) {
    score = 940;
  } else if (vNorm && sNorm && (sNorm.startsWith(vNorm) || vNorm.startsWith(sNorm)) && Math.min(vNorm.length, sNorm.length) >= 4) {
    score = 840;
  } else if (vNorm && sNorm && (vNorm.includes(sNorm) || sNorm.includes(vNorm)) && Math.min(vNorm.length, sNorm.length) >= 5) {
    score = 780;
  } else {
    const vEp = extractEpisodeTag(vNorm);
    const sEp = extractEpisodeTag(sNorm);
    const vTokens = extractCoreTokens(vNorm);
    const sTokens = extractCoreTokens(sNorm);
    const vSet = new Set(vTokens);
    const sSet = new Set(sTokens);
    let overlap = 0;
    for (const tok of sSet) {
      if (vSet.has(tok)) overlap += 1;
    }

    if (vEp && sEp && vEp === sEp) {
      score = overlap > 0 ? 790 + Math.min(60, overlap * 15) : 700;
    } else if (vEp && sEp && vEp !== sEp) {
      // Different episode numbers should NEVER falsely match!
      return 0;
    } else if (vSet.size > 0 && sSet.size > 0 && overlap > 0) {
      const ratio = (2 * overlap) / (vSet.size + sSet.size);
      if (ratio >= 0.48 || (overlap >= 2 && overlap / Math.min(vSet.size, sSet.size) >= 0.65)) {
        score = Math.round(520 + ratio * 240);
      }
    }
  }

  // Single-video folder fallback (e.g. a movie folder containing 1 video + "Arabic.srt" / "sub.srt")
  if (score === 0 && isOnlyVideoInDir && distancePenalty <= 40 && subCountInSameDir <= 4) {
    score = 420;
  }

  if (score === 0) return 0;

  // Prefer Arabic subtitle if multiple language subtitles match equally well
  if (SUB_ARABIC_HINT_RE.test(subFileName)) {
    score += 28;
  }
  return Math.max(1, score - distancePenalty);
}

ipcMain.handle('aaz:find-nearby-subtitle', async (_event, videoFullPath) => {
  try {
    if (!videoFullPath || !fs.existsSync(videoFullPath)) return null;
    const videoDir = path.dirname(videoFullPath);
    const videoName = path.basename(videoFullPath);
    const vNorm = normalizeMediaName(videoName);

    const searchDirs = [{ dir: videoDir, penalty: 0 }];
    const SUB_FOLDER_NAMES = new Set(['subs', 'subtitles', 'subtitle', 'sub', 'arabic', 'ar', 'en', 'cc', 'captions']);

    let videoCountInSameDir = 0;
    try {
      const sameEntries = fs.readdirSync(videoDir, { withFileTypes: true });
      for (const ent of sameEntries) {
        if (ent.isFile()) {
          const ext = path.extname(ent.name).slice(1).toLowerCase();
          if (VIDEO_EXTS.has(ext)) videoCountInSameDir += 1;
        } else if (ent.isDirectory()) {
          const lower = ent.name.toLowerCase();
          const subDirPath = path.join(videoDir, ent.name);
          if (SUB_FOLDER_NAMES.has(lower) || lower.includes('sub') || (vNorm.length >= 4 && normalizeMediaName(ent.name).includes(vNorm.slice(0, Math.min(vNorm.length, 10))))) {
            searchDirs.push({ dir: subDirPath, penalty: 20 });
            // Also check one level inside Subs/<VideoName>/ (common YTS / scene structure)
            try {
              const nested = fs.readdirSync(subDirPath, { withFileTypes: true });
              for (const nEnt of nested) {
                if (nEnt.isDirectory()) {
                  searchDirs.push({ dir: path.join(subDirPath, nEnt.name), penalty: 30 });
                }
              }
            } catch {}
          }
        }
      }
    } catch {}

    // Check parent directory & sibling Subs folder (penalty 55)
    const parentDir = path.dirname(videoDir);
    if (parentDir && parentDir !== videoDir) {
      searchDirs.push({ dir: parentDir, penalty: 55 });
      for (const subFolder of ['Subs', 'Subtitles', 'Subtitle', 'Arabic']) {
        const siblingSub = path.join(parentDir, subFolder);
        if (fs.existsSync(siblingSub)) {
          searchDirs.push({ dir: siblingSub, penalty: 65 });
        }
      }
    }

    const candidates = [];
    const seenPaths = new Set();
    for (const { dir, penalty } of searchDirs) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const subFilesHere = entries.filter((ent) => ent.isFile() && SUBTITLE_EXTS.has(path.extname(ent.name).slice(1).toLowerCase()));
      for (const ent of subFilesHere) {
        const fullPath = path.join(dir, ent.name);
        if (seenPaths.has(fullPath)) continue;
        seenPaths.add(fullPath);
        const score = scoreSubtitleCandidate(videoName, ent.name, penalty, videoCountInSameDir <= 1, subFilesHere.length);
        if (score >= 380) {
          candidates.push({ name: ent.name, fullPath, score });
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const text = decodeTextBufferSmart(fs.readFileSync(best.fullPath));
    return { name: best.name, fullPath: best.fullPath, text, score: best.score };
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

ipcMain.handle('aaz:set-always-on-top', (event, enabled) => {
  const ownerWin = BrowserWindow.fromWebContents(event.sender) || getPrimaryWindow();
  if (!ownerWin) return false;
  ownerWin.setAlwaysOnTop(Boolean(enabled), 'floating');
  return ownerWin.isAlwaysOnTop();
});

ipcMain.handle('aaz:set-fullscreen', (event, enabled) => {
  const ownerWin = BrowserWindow.fromWebContents(event.sender) || getPrimaryWindow();
  if (!ownerWin) return false;
  ownerWin.setFullScreen(Boolean(enabled));
  return ownerWin.isFullScreen();
});

ipcMain.handle('aaz:is-fullscreen', (event) => {
  const ownerWin = BrowserWindow.fromWebContents(event.sender) || getPrimaryWindow();
  return ownerWin ? ownerWin.isFullScreen() : false;
});

let cachedSystemFonts = null;
ipcMain.handle('aaz:list-system-fonts', async () => {
  if (Array.isArray(cachedSystemFonts) && cachedSystemFonts.length > 0) {
    return cachedSystemFonts;
  }

  const runExec = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve('');
      resolve(stdout);
    });
  });

  const fonts = new Set();
  if (process.platform === 'win32') {
    const psCmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }';
    const out = await runExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd]);
    if (out) {
      out.split(/\r?\n/).forEach((line) => {
        const name = line.trim();
        if (name) fonts.add(name);
      });
    }
    // Fallback to Windows Registry if .NET System.Drawing was unavailable
    if (fonts.size === 0) {
      const regOut = await runExec('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']);
      regOut.split(/\r?\n/).forEach((line) => {
        const m = line.match(/^\s+(.+?)\s+(?:\(TrueType\)|\(OpenType\))?\s+REG_SZ/i);
        if (m && m[1]) {
          const clean = m[1].replace(/\s*\((TrueType|OpenType|All res)\)\s*/gi, '').trim();
          if (clean) fonts.add(clean);
        }
      });
    }
  } else {
    const out = await runExec('fc-list', [':', 'family']);
    out.split(/\r?\n/).forEach((line) => {
      line.split(',').forEach((part) => {
        const name = part.trim();
        if (name) fonts.add(name);
      });
    });
  }

  cachedSystemFonts = [...fonts].sort((a, b) => a.localeCompare(b));
  return cachedSystemFonts;
});
