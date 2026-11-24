/**
 * Native Rust / Tauri v2 & Android Kotlin Platform Bridge Adapter (window.aazDesktop).
 * Safely attaches IPC commands on both Windows desktop (WebView2) and Android (WebView + Kotlin AAZAndroid bridge),
 * exposing platform feature detection (R6, R13, R17, R29-R34) so frontend code never assumes desktop-only APIs.
 */

export function detectAndroidEnvironment(win = typeof window !== 'undefined' ? window : null) {
  if (!win) return false;
  try {
    if (win.AAZAndroid && typeof win.AAZAndroid.isAvailable === 'function' && win.AAZAndroid.isAvailable()) {
      return true;
    }
    const ua = String(win.navigator?.userAgent || '');
    if (/\bAndroid\b/i.test(ua)) return true;
  } catch {
    // Ignore navigator access errors
  }
  return false;
}

export function buildPlatformCapabilities(isAndroid) {
  return {
    windowing: !isAndroid,
    taskbar: !isAndroid,
    setSinkId: !isAndroid,
    directoryPicker: !isAndroid,
    safPicker: isAndroid,
    mediaStoreScan: isAndroid,
    hierarchicalLibrary: isAndroid,
    touchGestures: isAndroid,
    windowsCast: !isAndroid,
    lanCast: true,
    nativeMedia3: isAndroid,
    foregroundPlayback: isAndroid,
    sensorRotation: isAndroid,
    directApkUpdater: isAndroid,
    dynamicSystemBars: isAndroid,
    allThemes16: true,
  };
}

export function attachDesktopBridge(win = typeof window !== 'undefined' ? window : null) {
  if (!win) return null;
  if (win.aazDesktop && win.aazDesktop.isTauri) return win.aazDesktop;

  let tauriApi = null;
  try {
    if (win.__TAURI__ && win.__TAURI__.core && win.__TAURI__.core.invoke) {
      tauriApi = win.__TAURI__;
    } else if (
      win.parent &&
      win.parent !== win &&
      win.parent.__TAURI__ &&
      win.parent.__TAURI__.core &&
      win.parent.__TAURI__.core.invoke
    ) {
      tauriApi = win.parent.__TAURI__;
    }
  } catch {
    // Ignore cross-origin parent inspection errors
  }

  const getAndroidNative = () => {
    try {
      return win.AAZAndroid && typeof win.AAZAndroid.isAvailable === 'function' && win.AAZAndroid.isAvailable()
        ? win.AAZAndroid
        : null;
    } catch {
      return null;
    }
  };

  if (!tauriApi && !getAndroidNative()) return null;

  const isAndroid = detectAndroidEnvironment(win);
  const invoke = (cmd, args = {}) =>
    tauriApi ? tauriApi.core.invoke(cmd, args) : Promise.resolve(null);

  // Async callback & event bridge for Android @JavascriptInterface (window.AAZAndroid)
  const androidCallbacks = new Map();
  const androidEventListeners = new Map();
  let androidCbSeq = 1;

  if (isAndroid) {
    win.__aazResolveAndroidCallback = (id, value) => {
      const resolver = androidCallbacks.get(id);
      if (!resolver) return;
      androidCallbacks.delete(id);
      resolver(value);
    };
    win.__aazOnAndroidEvent = (name, payload) => {
      const set = androidEventListeners.get(name);
      if (!set) return;
      for (const cb of set) {
        try {
          cb(payload);
        } catch {
          // Isolate listener errors
        }
      }
    };
  }

  const callAndroidAsync = (invokeNative) =>
    new Promise((resolve, reject) => {
      const native = getAndroidNative();
      if (!native) {
        resolve(null);
        return;
      }
      const cbId = `aaz_cb_${androidCbSeq++}_${Date.now()}`;
      const timer = setTimeout(() => {
        if (androidCallbacks.has(cbId)) {
          androidCallbacks.delete(cbId);
          resolve(null);
        }
      }, 120000);
      androidCallbacks.set(cbId, (val) => {
        clearTimeout(timer);
        if (val && typeof val === 'object' && typeof val.__aazError === 'string') {
          reject(new Error(val.__aazError));
          return;
        }
        resolve(val);
      });
      try {
        invokeNative(native, cbId);
      } catch (err) {
        clearTimeout(timer);
        androidCallbacks.delete(cbId);
        reject(err);
      }
    });

  const listenAndroidEvent = (eventName, cb) => {
    if (!androidEventListeners.has(eventName)) {
      androidEventListeners.set(eventName, new Set());
    }
    const set = androidEventListeners.get(eventName);
    set.add(cb);
    return Promise.resolve(() => set.delete(cb));
  };

  const listen = (eventName, cb) => {
    if (tauriApi && tauriApi.event && typeof tauriApi.event.listen === 'function') {
      return tauriApi.event
        .listen(eventName, (ev) => cb(ev ? ev.payload : null))
        .catch(() => () => {});
    }
    return Promise.resolve(() => {});
  };

  const listenWindow = (eventName, cb) => {
    if (isAndroid) {
      return listen(eventName, cb);
    }
    try {
      const currentWin = tauriApi?.webviewWindow?.getCurrentWebviewWindow?.();
      if (currentWin && typeof currentWin.listen === 'function') {
        return currentWin
          .listen(eventName, (ev) => cb(ev ? ev.payload : null))
          .catch(() => () => {});
      }
    } catch {
      // Fall back to global event listener if webviewWindow API is unavailable
    }
    return listen(eventName, cb);
  };

  const bridge = {
    isElectron: true, // Legacy compatibility flag used across existing modules
    isTauri: true,
    isAndroid,
    isDesktop: !isAndroid,
    platform: isAndroid ? 'android' : 'desktop',
    capabilities: buildPlatformCapabilities(isAndroid),
    getPlatformInfo: () => invoke('aaz_get_platform_info'),
    openNewWindow: () => invoke('aaz_new_window'),
    getAppVersion: () => {
      const native = getAndroidNative();
      if (isAndroid && native && typeof native.getAppVersion === 'function') {
        return Promise.resolve(String(native.getAppVersion() || '1.7.0'));
      }
      return invoke('aaz_get_app_version');
    },
    getLaunchFiles: async () => {
      const native = getAndroidNative();
      if (isAndroid && native && typeof native.getLaunchFilesJson === 'function') {
        try {
          const parsed = JSON.parse(native.getLaunchFilesJson() || '[]');
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        } catch {
          // Ignore malformed JSON
        }
      }
      return invoke('aaz_get_launch_files');
    },
    checkForUpdates: () => {
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) => native.checkForUpdates(cbId));
      }
      return invoke('aaz_check_updates');
    },
    downloadUpdate: () => {
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) => native.downloadUpdate(cbId));
      }
      return invoke('aaz_download_update');
    },
    installUpdate: () => {
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) => native.installUpdate(cbId));
      }
      return invoke('aaz_install_update');
    },
    onUpdateStatus: (callback) => {
      if (isAndroid) {
        return listenAndroidEvent('update-status', callback);
      }
      return listen('aaz:update-status', callback);
    },
    selectFolder: () => {
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) => native.selectFolder(cbId));
      }
      return invoke('aaz_select_folder');
    },
    // Android SAF grant without the recursive scan: hierarchical browsing
    // lists one level at a time instead (see listSafChildren).
    selectFolderShallow: () => {
      if (isAndroid && getAndroidNative() && typeof getAndroidNative().selectFolderShallow === 'function') {
        return callAndroidAsync((native, cbId) => native.selectFolderShallow(cbId));
      }
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) => native.selectFolder(cbId));
      }
      return invoke('aaz_select_folder');
    },
    // One directory level of a SAF tree (folders + media files, non-recursive).
    listSafChildren: (treeUri, parentDocId = '') => {
      if (isAndroid && getAndroidNative() && typeof getAndroidNative().listSafChildren === 'function') {
        return callAndroidAsync((native, cbId) =>
          native.listSafChildren(cbId, String(treeUri), String(parentDocId || ''))
        );
      }
      return Promise.resolve(null);
    },
    selectFiles: () => {
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) => native.selectFiles(cbId));
      }
      return invoke('aaz_select_files');
    },
    readFolder: (folderPath) => {
      if (isAndroid && getAndroidNative() && String(folderPath || '').startsWith('content://')) {
        return callAndroidAsync((native, cbId) => native.readFolder(cbId, String(folderPath)));
      }
      return invoke('aaz_read_folder', { folderPath });
    },
    readTextFile: (filePath) => {
      if (isAndroid && getAndroidNative() && String(filePath || '').startsWith('content://')) {
        return callAndroidAsync((native, cbId) => native.readTextFile(cbId, String(filePath)));
      }
      return invoke('aaz_read_text_file', { filePath });
    },
    findNearbySubtitle: (videoFullPath, preferredLang = 'auto', uiLang = 'en') => {
      if (isAndroid && getAndroidNative() && String(videoFullPath || '').startsWith('content://')) {
        return callAndroidAsync((native, cbId) =>
          native.findNearbySubtitle(cbId, String(videoFullPath), String(preferredLang || 'auto'), String(uiLang || 'en'))
        );
      }
      return invoke('aaz_find_nearby_subtitle', { videoFullPath, preferredLang, uiLang });
    },
    inspectPaths: (paths) => {
      if (isAndroid && getAndroidNative()) {
        const list = Array.isArray(paths) ? paths : [];
        return callAndroidAsync((native, cbId) => native.inspectPaths(cbId, JSON.stringify(list)));
      }
      return invoke('aaz_inspect_paths', { paths });
    },
    scanDeviceMedia: () => {
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) => native.scanDeviceMedia(cbId));
      }
      return Promise.resolve(null);
    },
    saveTextFile: (filename, content, mimeType = 'text/plain') => {
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) =>
          native.saveTextFile(cbId, String(filename || 'aaz-export.txt'), String(content || ''), String(mimeType || 'text/plain'))
        );
      }
      return Promise.resolve(null);
    },
    setAlwaysOnTop: (enabled) => invoke('aaz_set_always_on_top', { enabled: Boolean(enabled) }),
    setWindowFullscreen: (enabled) => invoke('aaz_set_fullscreen', { enabled: Boolean(enabled) }),
    isWindowFullscreen: () => invoke('aaz_is_fullscreen'),
    minimizeWindow: () => invoke('aaz_win_minimize'),
    toggleMaximize: () => invoke('aaz_win_toggle_maximize'),
    isMaximized: () => invoke('aaz_win_is_maximized'),
    closeWindow: () => invoke('aaz_win_close'),
    startWindowDrag: () => invoke('aaz_win_start_drag'),
    getWindowGeometry: () => invoke('aaz_get_window_geometry'),
    applyWindowGeometry: ({ x, y, width, height, maximized }) =>
      invoke('aaz_apply_window_geometry', {
        x: Math.round(Number(x) || 0),
        y: Math.round(Number(y) || 0),
        width: Math.max(460, Math.round(Number(width) || 1220)),
        height: Math.max(540, Math.round(Number(height) || 780)),
        maximized: Boolean(maximized),
      }),
    setMiniMode: ({ enabled, x, y, width, height, alwaysOnTop, maximized }) =>
      invoke('aaz_set_mini_mode', {
        enabled: Boolean(enabled),
        x: typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : null,
        y: typeof y === 'number' && Number.isFinite(y) ? Math.round(y) : null,
        width: typeof width === 'number' && Number.isFinite(width) ? Math.round(width) : null,
        height: typeof height === 'number' && Number.isFinite(height) ? Math.round(height) : null,
        alwaysOnTop: typeof alwaysOnTop === 'boolean' ? alwaysOnTop : null,
        maximized: typeof maximized === 'boolean' ? maximized : null,
      }),
    updateTaskbarState: ({ hasMedia, isPlaying, canPrev, canNext, lang }) =>
      invoke('aaz_taskbar_update_state', {
        hasMedia: Boolean(hasMedia),
        isPlaying: Boolean(isPlaying),
        canPrev: Boolean(canPrev),
        canNext: Boolean(canNext),
        lang: lang === 'ar' ? 'ar' : 'en',
      }),
    onTaskbarAction: (callback) => listenWindow('aaz:taskbar-action', callback),
    saveSnapshot: (dataBase64, suggestedName) => {
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) =>
          native.saveSnapshot(cbId, String(dataBase64 || ''), String(suggestedName || 'aaz-snapshot.png'))
        );
      }
      return invoke('aaz_save_snapshot', { dataBase64, suggestedName });
    },
    listSystemFonts: () => invoke('aaz_list_system_fonts'),
    castStartServer: (mediaPath, title, subtitleVtt = null) => {
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) =>
          native.castStartServer(cbId, String(mediaPath || ''), String(title || ''), String(subtitleVtt || ''))
        );
      }
      return invoke('aaz_cast_start_server', { mediaPath, title, subtitleVtt });
    },
    castStopServer: () => {
      const native = getAndroidNative();
      if (isAndroid && native && typeof native.castStopServer === 'function') {
        native.castStopServer();
        return Promise.resolve(true);
      }
      return invoke('aaz_cast_stop_server');
    },
    castDiscoverDevices: () => {
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) => native.castDiscoverDevices(cbId));
      }
      return invoke('aaz_cast_discover_devices');
    },
    castToDlna: (controlUrl, mediaUrl, title, mimeType) => {
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) =>
          native.castToDlna(
            cbId,
            String(controlUrl || ''),
            String(mediaUrl || ''),
            String(title || ''),
            String(mimeType || 'video/mp4')
          )
        );
      }
      return invoke('aaz_cast_to_dlna', { controlUrl, mediaUrl, title, mimeType });
    },
    castDlnaControl: (controlUrl, action, seekTarget = null) => {
      if (isAndroid && getAndroidNative()) {
        return callAndroidAsync((native, cbId) =>
          native.castDlnaControl(cbId, String(controlUrl || ''), String(action || ''))
        );
      }
      return invoke('aaz_cast_dlna_control', { controlUrl, action, seekTarget });
    },
    castOpenWindowsCast: () => invoke('aaz_cast_open_windows_cast'),
    setSystemBarStyle: (bgHex, isLight) => {
      const native = getAndroidNative();
      if (native && typeof native.setSystemBarStyle === 'function') {
        native.setSystemBarStyle(String(bgHex || '#060b08'), Boolean(isLight));
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    onOpenExternal: (callback) => {
      if (isAndroid) {
        listenAndroidEvent('open-external', callback);
      }
      return listenWindow('aaz:open-external', callback);
    },
    onFileDrop: (callback) => listenWindow('tauri://drag-drop', callback),

    // Android Native System & MediaSession Controls
    onMediaAction: (callback) => {
      if (isAndroid) {
        return listenAndroidEvent('media-action', callback);
      }
      return listen('aaz:media-action', callback);
    },
    onOrientationChange: (callback) => {
      if (isAndroid) {
        return listenAndroidEvent('orientation-change', callback);
      }
      return Promise.resolve(() => {});
    },
    onPipChange: (callback) => {
      if (isAndroid) {
        return listenAndroidEvent('pip-change', callback);
      }
      return Promise.resolve(() => {});
    },
    setScreenBrightness: (level) => {
      const native = getAndroidNative();
      const clamped = Math.min(1, Math.max(0.05, Number(level) || 0.5));
      if (native && typeof native.setBrightness === 'function') {
        native.setBrightness(clamped);
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    setVideoMode: (active) => {
      const native = getAndroidNative();
      if (native && typeof native.setVideoMode === 'function') {
        native.setVideoMode(Boolean(active));
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    toggleOrientationLock: () => {
      const native = getAndroidNative();
      if (native && typeof native.toggleOrientationLock === 'function') {
        return Promise.resolve(Boolean(native.toggleOrientationLock()));
      }
      return Promise.resolve(false);
    },
    isOrientationLocked: () => {
      const native = getAndroidNative();
      if (native && typeof native.isOrientationLocked === 'function') {
        return Promise.resolve(Boolean(native.isOrientationLocked()));
      }
      return Promise.resolve(false);
    },
    rotateScreenNow: () => {
      const native = getAndroidNative();
      if (native && typeof native.rotateScreenNow === 'function') {
        return Promise.resolve(Boolean(native.rotateScreenNow()));
      }
      return Promise.resolve(false);
    },
    setOrientation: (mode) => {
      const native = getAndroidNative();
      if (native && typeof native.setOrientation === 'function') {
        native.setOrientation(String(mode || 'auto'));
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    setImmersiveFullscreen: (enabled) => {
      const native = getAndroidNative();
      if (native && typeof native.setImmersiveFullscreen === 'function') {
        native.setImmersiveFullscreen(Boolean(enabled));
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    enterPictureInPicture: () => {
      const native = getAndroidNative();
      if (native && typeof native.enterPictureInPicture === 'function') {
        return Promise.resolve(Boolean(native.enterPictureInPicture()));
      }
      return Promise.resolve(false);
    },
    updateMediaSession: ({ title = '', artist = '', isPlaying = false, positionMs = 0, durationMs = 0 } = {}) => {
      const native = getAndroidNative();
      if (native && typeof native.updateMediaSession === 'function') {
        native.updateMediaSession(
          String(title || ''),
          String(artist || ''),
          Boolean(isPlaying),
          Math.max(0, Math.round(Number(positionMs) || 0)),
          Math.max(0, Math.round(Number(durationMs) || 0))
        );
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    playerLoad: (mediaRef, startMs = 0) =>
      invoke('aaz_android_player_load', { mediaRef, startMs: Math.max(0, Math.round(Number(startMs) || 0)) }),
    playerPlay: () => invoke('aaz_android_player_play'),
    playerPause: () => invoke('aaz_android_player_pause'),
    playerSeek: (positionMs) =>
      invoke('aaz_android_player_seek', { positionMs: Math.max(0, Math.round(Number(positionMs) || 0)) }),
    playerSetRate: (rate) => invoke('aaz_android_player_set_rate', { rate: Number(rate) || 1 }),
    playerSetVolume: (volume, systemStream = false) =>
      invoke('aaz_android_player_set_volume', {
        volume: Math.min(1, Math.max(0, Number(volume) || 0)),
        systemStream: Boolean(systemStream),
      }),
  };

  // Refine capabilities asynchronously from Rust aaz_get_platform_info without blocking boot
  invoke('aaz_get_platform_info')
    .then((info) => {
      if (!info || typeof info !== 'object') return;
      if (typeof info.isAndroid === 'boolean') {
        bridge.isAndroid = info.isAndroid;
        bridge.isDesktop = !info.isAndroid;
        bridge.platform = info.isAndroid ? 'android' : info.os || 'desktop';
      }
      if (info.capabilities && typeof info.capabilities === 'object') {
        Object.assign(bridge.capabilities, info.capabilities);
      }
    })
    .catch(() => {});

  win.aazDesktop = bridge;
  return bridge;
}
