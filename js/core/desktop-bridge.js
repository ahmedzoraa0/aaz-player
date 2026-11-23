/**
 * Native Rust / Tauri v2 Platform Bridge Adapter (window.aazDesktop).
 * Safely attaches IPC commands on both Windows desktop (WebView2) and Android (WebView + Kotlin plugins),
 * exposing platform feature detection (R6, R13, R17) so frontend code never assumes desktop-only APIs.
 */

export function detectAndroidEnvironment(win = typeof window !== 'undefined' ? window : null) {
  if (!win) return false;
  try {
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
    touchGestures: isAndroid,
    windowsCast: !isAndroid,
    nativeMedia3: isAndroid,
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

  if (!tauriApi) return null;

  const isAndroid = detectAndroidEnvironment(win);
  const invoke = (cmd, args = {}) => tauriApi.core.invoke(cmd, args);
  const listen = (eventName, cb) => {
    if (tauriApi.event && typeof tauriApi.event.listen === 'function') {
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
      const currentWin = tauriApi.webviewWindow?.getCurrentWebviewWindow?.();
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
    getAppVersion: () => invoke('aaz_get_app_version'),
    getLaunchFiles: () => invoke('aaz_get_launch_files'),
    checkForUpdates: () => invoke('aaz_check_updates'),
    downloadUpdate: () => invoke('aaz_download_update'),
    installUpdate: () => invoke('aaz_install_update'),
    onUpdateStatus: (callback) => listen('aaz:update-status', callback),
    selectFolder: () => invoke('aaz_select_folder'),
    selectFiles: () => invoke('aaz_select_files'),
    readFolder: (folderPath) => invoke('aaz_read_folder', { folderPath }),
    readTextFile: (filePath) => invoke('aaz_read_text_file', { filePath }),
    findNearbySubtitle: (videoFullPath, preferredLang = 'auto', uiLang = 'en') =>
      invoke('aaz_find_nearby_subtitle', { videoFullPath, preferredLang, uiLang }),
    inspectPaths: (paths) => invoke('aaz_inspect_paths', { paths }),
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
    saveSnapshot: (dataBase64, suggestedName) =>
      invoke('aaz_save_snapshot', { dataBase64, suggestedName }),
    listSystemFonts: () => invoke('aaz_list_system_fonts'),
    castStartServer: (mediaPath, title, subtitleVtt = null) =>
      invoke('aaz_cast_start_server', { mediaPath, title, subtitleVtt }),
    castStopServer: () => invoke('aaz_cast_stop_server'),
    castDiscoverDevices: () => invoke('aaz_cast_discover_devices'),
    castToDlna: (controlUrl, mediaUrl, title, mimeType) =>
      invoke('aaz_cast_to_dlna', { controlUrl, mediaUrl, title, mimeType }),
    castDlnaControl: (controlUrl, action, seekTarget = null) =>
      invoke('aaz_cast_dlna_control', { controlUrl, action, seekTarget }),
    castOpenWindowsCast: () => invoke('aaz_cast_open_windows_cast'),
    onOpenExternal: (callback) => listenWindow('aaz:open-external', callback),
    onFileDrop: (callback) => listenWindow('tauri://drag-drop', callback),

    // Android Phase 1 / Phase 3 Native Media3 & System Control Bridge Contract (R13, R20, R35)
    playerLoad: (mediaRef, positionMs = 0) =>
      invoke('plugin:aaz-media|load', { mediaRef, positionMs: Math.max(0, Math.round(Number(positionMs) || 0)) }),
    playerPlay: () => invoke('plugin:aaz-media|play'),
    playerPause: () => invoke('plugin:aaz-media|pause'),
    playerSeekTo: (positionMs) =>
      invoke('plugin:aaz-media|seekTo', { positionMs: Math.max(0, Math.round(Number(positionMs) || 0)) }),
    playerSetSpeed: (speed) => invoke('plugin:aaz-media|setSpeed', { speed: Number(speed) || 1 }),
    playerSetVolume: (volume, useSystemStream = false) =>
      invoke('plugin:aaz-media|setVolume', {
        volume: Math.min(1, Math.max(0, Number(volume) || 0)),
        useSystemStream: Boolean(useSystemStream),
      }),
    playerGetState: () => invoke('plugin:aaz-media|getState'),
    onPlayerState: (callback) => listen('aaz:player-state', callback),
    onMediaAction: (callback) => listen('aaz:media-action', callback),
    setScreenBrightness: (level) =>
      invoke('plugin:aaz-media|setBrightness', { level: Math.min(1, Math.max(0.05, Number(level) || 0.5)) }),
    setOrientation: (mode) => invoke('plugin:aaz-media|setOrientation', { mode }),
    setImmersiveFullscreen: (enabled) =>
      invoke('plugin:aaz-media|setImmersiveFullscreen', { enabled: Boolean(enabled) }),
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
